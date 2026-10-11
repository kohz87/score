import { spawn } from 'node:child_process'
import { kernelGroupExists, procAvailable, scanGroup, type MemberIdentity } from './proc.ts'
import { CODING_LIMITS, type CodingEvent, type LineParser } from './types.ts'

export type StopReason = 'user' | 'timeout' | 'output_limit' | 'shutdown'

export interface CliOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stopped: StopReason | null
  /** Tail of stderr, unredacted (callers redact before storing). */
  stderr: string
  /** The process could not be started at all. */
  spawnError: string | null
  /**
   * The CLI's own process ended, but tools it started were still running; they were given the grace period and then
   * stopped (S2-005).
   */
  leftovers: boolean
  /** The whole process group is empty. False only when something survived SIGKILL: the durable record must stay. */
  groupGone: boolean
  /** Whether the CLI printed any line we understood. */
  sawEvents: boolean
  stats: LineParser['stats']
}

/**
 * `onSpawn` threw. The group has been sent SIGKILL; `terminated` settles (true = the whole group is gone) so the
 * caller can wait for the proof before it reports anything.
 */
export class SpawnRecordError extends Error {
  constructor(
    readonly original: unknown,
    readonly terminated: Promise<boolean>,
  ) {
    super(original instanceof Error ? original.message : String(original), { cause: original })
  }
}

export interface CliRun {
  /** SIGINT, then SIGTERM, then SIGKILL, a few seconds apart. Safe to call more than once. */
  stop(reason?: StopReason): void
  readonly pid: number | undefined
  done: Promise<CliOutcome>
}

export interface SpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  parser: LineParser
  /** Called in order, one at a time; a rejection is the caller's to handle (the run goes on). */
  onEvent(event: CodingEvent): Promise<void>
  /**
   * Called synchronously right after the spawn (records the process durably). Supervision is installed first; if this
   * throws, the whole group is killed and the error propagates (S2-004).
   */
  onSpawn?(pid: number): void
  /**
   * Called with the identities (pid + start time) of group members not reported before: while the leader runs, when it
   * exits with survivors, and while the group is reaped. They are the continuity that lets a leaderless group be
   * recognised as ours after a restart (N4). A throw is ignored: recording is best effort, never a reason to fail.
   */
  onMembers?(members: MemberIdentity[]): void
  /** Test seam: the kernel's answer to "does any process have this PGID" (default `kill(-pgid, 0)`). */
  groupExists?: typeof kernelGroupExists
  /** How often members are noted while the leader runs (default 2 s). */
  memberScanMs?: number
  maxMs?: number
  graceMs?: number
  /** Test seam: how signals are sent (to fake a survivor that ignores them). */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Test seam: how long past the second grace the reaper keeps trying before it gives up (default 10 s). */
  reapSlackMs?: number
}

/**
 * One CLI process per turn: argv only (no shell), the prompt on stdin, JSON lines on stdout. Output is capped, a
 * turn has a wall-clock limit, and Stop escalates SIGINT -> SIGTERM -> SIGKILL.
 */
export function spawnCli(options: SpawnOptions): CliRun {
  const { maxMs = CODING_LIMITS.maxTurnMs, graceMs = CODING_LIMITS.stopGraceMs } = options
  const sendSignal =
    options.kill ?? ((pid: number, name: NodeJS.Signals) => process.kill(pid, name))
  let stopped: StopReason | null = null
  let spawnError: string | null = null
  let sawEvents = false
  let stderr = ''
  let total = 0
  let buffered = ''
  let skipping = false
  let queue: Promise<void> = Promise.resolve()
  const timers: NodeJS.Timeout[] = []
  // Only the wall-clock timer; the escalation timers outlive the leader until its whole group is gone.
  const escalation: NodeJS.Timeout[] = []

  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group, so Stop reaches the tools the CLI started too.
    detached: true,
  })
  // A process group id is only ours to signal while we created it and have not seen it empty: once the last member is
  // gone the kernel may hand the same number to an unrelated group, so `groupEmpty` ends all signalling.
  let groupEmpty = false
  let leaderExited = false
  let leftovers = false
  const signal = (name: NodeJS.Signals) => {
    if (child.pid === undefined || groupEmpty) return
    try {
      sendSignal(-child.pid, name)
    } catch {
      if (!leaderExited) {
        try {
          child.kill(name)
        } catch {
          // already gone
        }
      }
    }
  }
  // Identities already reported, so each is recorded once.
  const noted = new Set<string>()
  let lastNoted = 0
  const noteMembers = (force = false) => {
    if (child.pid === undefined || !options.onMembers || !procAvailable()) return
    const now = Date.now()
    if (!force && now - lastNoted < 200) return
    lastNoted = now
    const fresh = scanGroup(child.pid).members.filter((member) => {
      const key = `${member.pid}:${member.startTime}`
      if (noted.has(key)) return false
      noted.add(key)
      return true
    })
    if (fresh.length === 0) return
    try {
      options.onMembers(fresh)
    } catch {
      // best effort
    }
  }
  // "The group is gone" is the kernel's word alone (ESRCH from kill(-pgid, 0)): a /proc listing can miss a child that
  // forked after it was read (N5), so it never overrides a positive answer. A zombie waiting for its reaper still
  // counts: the group is not gone until it is.
  const groupAlive = (): boolean => {
    if (child.pid === undefined || groupEmpty) return false
    if ((options.groupExists ?? kernelGroupExists)(child.pid) === 'none') {
      groupEmpty = true
      return false
    }
    return true
  }
  function stop(reason: StopReason = 'user'): void {
    if (stopped !== null) return
    // After the leader has gone Stop still acts, as long as a member of the group lives.
    if (leaderExited && !groupAlive()) return
    stopped = reason
    signal('SIGINT')
    const term = setTimeout(() => signal('SIGTERM'), graceMs)
    const kill = setTimeout(() => signal('SIGKILL'), graceMs * 2)
    term.unref()
    kill.unref()
    escalation.push(term, kill)
  }
  const scanner = setInterval(() => {
    if (!leaderExited) noteMembers()
  }, options.memberScanMs ?? 2000)
  scanner.unref()
  const wall = setTimeout(() => stop('timeout'), maxMs)
  wall.unref()
  timers.push(wall)

  function handleLine(line: string): void {
    if (!line.trim()) return
    const events = options.parser.parse(line)
    if (events.length) sawEvents = true
    for (const event of events)
      queue = queue.then(() => options.onEvent(event)).catch(() => undefined)
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    total += Buffer.byteLength(chunk)
    if (total > CODING_LIMITS.maxOutputBytes) {
      stop('output_limit')
      return
    }
    buffered += chunk
    let index: number
    while ((index = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (skipping) skipping = false
      else if (Buffer.byteLength(line) > CODING_LIMITS.maxLineBytes)
        options.parser.stats.malformed++
      else handleLine(line)
    }
    // A line that never ends is dropped once it passes the cap.
    if (buffered.length > CODING_LIMITS.maxLineBytes) {
      buffered = ''
      skipping = true
      options.parser.stats.malformed++
    }
  })
  child.stdout.on('error', () => undefined)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-CODING_LIMITS.stderrBytes)
  })
  child.stderr.on('error', () => undefined)
  // The CLI may exit without reading all of stdin.
  child.stdin.on('error', () => undefined)
  child.stdin.end(options.stdin)

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // The turn is over when the leader has ended AND nothing of its group is left. A tool that ignores the signals
  // gets SIGKILL; a leader that ended cleanly while tools run on gets the grace period, then SIGTERM, then SIGKILL.
  const reapOnce = async (): Promise<boolean> => {
    if (child.pid === undefined) return true
    const exitedAt = Date.now()
    const hardMs = graceMs * 2 + (options.reapSlackMs ?? 10_000)
    const deadline = exitedAt + hardMs
    let terminated = false
    while (groupAlive()) {
      noteMembers()
      const now = Date.now()
      if (stopped === null && !terminated && now - exitedAt >= graceMs) {
        leftovers = true
        terminated = true
        signal('SIGTERM')
      }
      if (now >= exitedAt + graceMs * 2) signal('SIGKILL')
      if (now >= deadline) return false
      await pause(25)
    }
    return true
  }

  let reaped: Promise<boolean> | null = null
  const reapGroup = () => (reaped ??= reapOnce())

  const done = new Promise<CliOutcome>((resolve) => {
    let settled = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    let closed = false
    const settle = () => {
      if (settled || !closed || !leaderExited) return
      settled = true
      if (!skipping && buffered.trim() && Buffer.byteLength(buffered) <= CODING_LIMITS.maxLineBytes)
        handleLine(buffered)
      void queue
        .then(() => reapGroup())
        .then((gone) => {
          for (const timer of timers) clearTimeout(timer)
          clearInterval(scanner)
          for (const timer of escalation) clearTimeout(timer)
          resolve({
            exitCode,
            signal: exitSignal,
            stopped,
            stderr,
            spawnError,
            sawEvents,
            stats: options.parser.stats,
            leftovers,
            groupGone: gone,
          })
        })
    }
    child.on('error', (error) => {
      spawnError = (error as NodeJS.ErrnoException).code ?? 'spawn_failed'
      leaderExited = true
      groupEmpty = true
      closed = true
      settle()
    })
    child.on('exit', (code, sig) => {
      exitCode = code
      exitSignal = sig
      leaderExited = true
      // Survivors are recorded before anything is signalled: from here on only continuity can vouch for them.
      noteMembers(true)
      // Output may stay open for good when a descendant holds the pipes: supervise the group now, not at close.
      void (async () => {
        const gone = await reapGroup()
        // Everything is dead, so the pipes close on their own; don't wait for ever if they don't. A survivor that
        // ignores SIGKILL may hold them open for good: the turn still ends, with groupGone false (never "completed
        // and clean").
        if (gone) await pause(1000)
        if (!closed) {
          child.stdout.destroy()
          child.stderr.destroy()
          closed = true
          settle()
        }
      })()
    })
    child.on('close', () => {
      closed = true
      settle()
    })
  })

  if (child.pid !== undefined && options.onSpawn) {
    try {
      options.onSpawn(child.pid)
    } catch (error) {
      // Nothing was returned to the caller, so nothing else will ever stop this group: end it here.
      if (stopped === null) stopped = 'shutdown'
      signal('SIGKILL')
      throw new SpawnRecordError(
        error,
        done.then((outcome) => outcome.groupGone),
      )
    }
  }
  return { stop, pid: child.pid, done }
}
