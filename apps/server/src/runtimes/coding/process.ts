import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'
import { GATE_FD, PDEATHSIG_SCRIPT, pdeathsigSupport } from './pdeathsig-exec.ts'
import { signalGroup, signalPid } from './pidfd-signal.ts'
import {
  kernelGroupExists,
  procAvailable,
  processStart,
  scanGroup,
  scanOwnedAfterExit,
  realProcEnv,
  type ProcEnv,
  type MemberIdentity,
} from './proc.ts'
import { BoundedDiagnostics } from './note.ts'
import { CODING_LIMITS, type CodingEvent, type LineParser } from './types.ts'

export type StopReason = 'user' | 'timeout' | 'output_limit' | 'shutdown'

const STOP_CAUSE: Record<StopReason, string> = {
  user: 'user',
  timeout: 'deadline',
  output_limit: 'output-cap',
  shutdown: 'score-shutdown',
}
/** The cause string the stop-recording hook receives. */
export function stopCauseOf(reason: StopReason): string {
  return STOP_CAUSE[reason]
}

export interface CliOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stopped: StopReason | null
  /** The start of stderr, already redacted and bounded (a tail cut through a labelled value would leak it). */
  stderr: string
  /**
   * Whether the whole stdout stream was seen and handled: no partial last line, no read error and no dropped (oversized)
   * record. False disqualifies the result, as for the supervised unit.
   */
  streamComplete: boolean
  /** Why the stream is incomplete (empty when complete). */
  streamLoss: string[]
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
   * throws, the whole group is killed and the error propagates (S2-004). The CLI is not executed, and gets no prompt,
   * until this has returned.
   */
  onSpawn?(pid: number): void
  /**
   * Called with the identities (pid + start time) of group members not reported before: while the leader runs, when it
   * exits with survivors, and while the group is reaped. They are the continuity that lets a leaderless group be
   * recognised as ours after a restart (N4). A throw never fails the run: the members are offered again on the next scan.
   */
  onMembers?(members: MemberIdentity[]): void
  /** A save failed; the same members are offered again on the next scan. Called once per streak of failures. */
  onMembersError?(error: unknown): void
  /**
   * Called once, synchronously, with the cause (`user`, `deadline`, `output-cap`, `score-shutdown`) before the group is
   * first signalled, on every stop path. It must not throw; if it does, `onStopError` hears of it and the stop goes on.
   */
  onStop?(cause: string): void
  onStopError?(error: unknown): void
  /** Test seam: the process table (default /proc). */
  procEnv?: ProcEnv
  /** Test seam: the kernel's answer to "does any process have this PGID" (default `kill(-pgid, 0)`). */
  groupExists?: typeof kernelGroupExists
  /** How often members are noted while the leader runs (default 100 ms: members found while the leader lives are the only proof of ownership once it has exited). */
  memberScanMs?: number
  maxMs?: number
  graceMs?: number
  /**
   * Test seams for how signals are sent (to fake a survivor that ignores them, or an unavailable/mismatching pidfd).
   * Defaults go through pidfds; there is no numeric kill anywhere in this module.
   */
  signalGroup?: typeof signalGroup
  signalPid?: typeof signalPid
  /** Test seam: how long past the second grace the reaper keeps trying before it gives up (default 10 s). */
  reapSlackMs?: number
}

/**
 * One CLI process per turn: argv only (no shell), the prompt on stdin, JSON lines on stdout. Output is capped, a
 * turn has a wall-clock limit, and Stop escalates SIGINT -> SIGTERM -> SIGKILL.
 */
export function spawnCli(options: SpawnOptions): CliRun {
  const { maxMs = CODING_LIMITS.maxTurnMs, graceMs = CODING_LIMITS.stopGraceMs } = options
  const sendGroup = options.signalGroup ?? signalGroup
  const sendPid = options.signalPid ?? signalPid
  let stopped: StopReason | null = null
  let spawnError: string | null = null
  let sawEvents = false
  const stderr = new BoundedDiagnostics()
  const streamLoss = new Set<string>()
  let total = 0
  let buffered = ''
  let skipping = false
  let queue: Promise<void> = Promise.resolve()
  const timers: NodeJS.Timeout[] = []
  // Only the wall-clock timer; the escalation timers outlive the leader until its whole group is gone.
  const escalation: NodeJS.Timeout[] = []

  // The CLI is started through a small launcher that asks the kernel to kill it when Score dies (PDEATHSIG) and that
  // only runs the CLI after Score has recorded the process (the gate). Without python there is no such guarantee, so
  // nothing is started. Tools the CLI starts itself are not covered: they may keep running until Score restarts and
  // stops them.
  const support = pdeathsigSupport()
  if (support.python === null) {
    return {
      stop: () => undefined,
      pid: undefined,
      done: Promise.resolve({
        exitCode: null,
        signal: null,
        stopped: null,
        stderr: support.detail,
        streamComplete: true,
        streamLoss: [],
        spawnError: 'python_unavailable',
        leftovers: false,
        groupGone: true,
        sawEvents: false,
        stats: options.parser.stats,
      }),
    }
  }
  const child = spawn(
    support.python,
    [
      '-I',
      PDEATHSIG_SCRIPT,
      String(process.pid),
      String(GATE_FD),
      '--',
      options.file,
      ...options.args,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      // fd 3 is the gate: the launcher runs the CLI only after "g" arrives on it.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      // Own process group, so Stop reaches the tools the CLI started too.
      detached: true,
    },
  )
  // A process group id is only ours to signal while we created it and have not seen it empty: once the last member is
  // gone the kernel may hand the same number to an unrelated group, so `groupEmpty` ends all signalling.
  let groupEmpty = false
  let leaderExited = false
  let leftovers = false
  // The leader's start time, read at spawn (the exec inside the launcher keeps it): with the pid it names this process
  // for good, and every signal below is delivered through a pidfd that verifies it (AA4). Never a numeric kill: if
  // identity cannot be proven the signal is not sent, the group stays alive, and the run ends unconfirmed with its
  // record kept, so the fence and Release apply (as in recovery).
  const leaderStart = child.pid === undefined ? null : processStart(child.pid)
  const env = options.procEnv ?? realProcEnv
  // Identities proven ours (pid -> start time): the leader, and everything seen in the group while the leader lived.
  // After the leader exits only these, and processes descending from them, may be signalled or recorded: a listing of
  // the group number proves existence, not ownership (v6 review, finding 5).
  const owned = new Map<number, string>()
  if (child.pid !== undefined && leaderStart !== null) owned.set(child.pid, leaderStart)
  /** Live members of the group that are ours; `foreign` = something else holds the group number. */
  const ownMembers = (): { members: MemberIdentity[]; foreign: boolean } => {
    if (child.pid === undefined) return { members: [], foreign: false }
    if (!leaderExited) {
      const members = scanGroup(child.pid, env).members
      for (const member of members) owned.set(member.pid, member.startTime)
      return { members, foreign: false }
    }
    const found = scanOwnedAfterExit(child.pid, owned, env)
    for (const member of found.members) owned.set(member.pid, member.startTime)
    return found
  }
  /** True when the signal was delivered to something; false when identity could not be proven and nothing was sent. */
  const signal = (name: NodeJS.Signals): boolean => {
    if (child.pid === undefined || groupEmpty || leaderStart === null) return false
    try {
      if (!leaderExited) return sendGroup(child.pid, leaderStart, name) === 'signalled'
      // The leader is gone, so there is no pidfd to signal the group through: each remaining member goes individually,
      // by its own pid + start time.
      let delivered = false
      for (const member of ownMembers().members)
        if (sendPid(member.pid, member.startTime, name) === 'signalled') delivered = true
      return delivered
    } catch {
      // best effort; the reaper reports a group that survived
      return false
    }
  }
  // Set by `done`: ends the turn as unconfirmed when SIGKILL could not be delivered to a leader that is still running
  // (nothing else would ever end the turn, and nothing may be signalled by number).
  let abandoned = false
  let giveUp: () => void = () => undefined
  // Identities already reported, so each is recorded once.
  const noted = new Set<string>()
  let lastNoted = 0
  let failedMembers = 0
  const noteMembers = (force = false) => {
    if (child.pid === undefined || !procAvailable()) return
    const now = Date.now()
    if (!force && now - lastNoted < 50) return
    lastNoted = now
    const fresh = ownMembers().members.filter(
      (member) => !noted.has(`${member.pid}:${member.startTime}`),
    )
    if (fresh.length === 0 || !options.onMembers) return
    try {
      options.onMembers(fresh)
      // Only now are they recorded: a failed save leaves them eligible for the next scan (S3-005).
      for (const member of fresh) noted.add(`${member.pid}:${member.startTime}`)
      failedMembers = 0
    } catch (error) {
      // Retried on the next scan; the caller hears about it once per streak, so a persistent failure is visible.
      if (failedMembers++ === 0) options.onMembersError?.(error)
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
  function recordStop(reason: StopReason): void {
    try {
      options.onStop?.(STOP_CAUSE[reason])
    } catch (error) {
      options.onStopError?.(error)
    }
  }
  function stop(reason: StopReason = 'user'): void {
    if (stopped !== null) return
    // After the leader has gone Stop still acts, as long as a member of the group lives.
    if (leaderExited && !groupAlive()) return
    stopped = reason
    recordStop(reason)
    signal('SIGINT')
    const term = setTimeout(() => signal('SIGTERM'), graceMs)
    const kill = setTimeout(() => {
      if (signal('SIGKILL') || leaderExited) return
      const abandon = setTimeout(() => giveUp(), options.reapSlackMs ?? 10_000)
      abandon.unref()
      escalation.push(abandon)
    }, graceMs * 2)
    term.unref()
    kill.unref()
    escalation.push(term, kill)
  }
  const scanner = setInterval(() => {
    if (!leaderExited) noteMembers()
  }, options.memberScanMs ?? 100)
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
    if (abandoned) return
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
      else if (Buffer.byteLength(line) > CODING_LIMITS.maxLineBytes) {
        options.parser.stats.malformed++
        streamLoss.add('dropped-record')
      } else handleLine(line)
    }
    // A line that never ends is dropped once it passes the cap.
    if (buffered.length > CODING_LIMITS.maxLineBytes) {
      buffered = ''
      skipping = true
      options.parser.stats.malformed++
      streamLoss.add('dropped-record')
    }
  })
  child.stdout.on('error', () => streamLoss.add('read-error'))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (abandoned) return
    stderr.push(chunk)
  })
  child.stderr.on('error', () => streamLoss.add('read-error'))
  // The CLI may exit without reading all of stdin.
  child.stdin.on('error', () => undefined)
  const gate = child.stdio[GATE_FD] as Writable | null
  gate?.on('error', () => undefined)
  // Launches the CLI and hands it its prompt: only after the process has been recorded.
  const release = () => {
    gate?.end('g')
    child.stdin.end(options.stdin)
  }

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
      // A last line with no newline may be a cut-off record: it is never parsed, and the stream is not complete.
      if (!skipping && buffered.trim()) streamLoss.add('partial-last-line')
      if (abandoned) streamLoss.add('abandoned')
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
            stderr: stderr.text(),
            streamComplete: streamLoss.size === 0,
            streamLoss: [...streamLoss],
            spawnError,
            sawEvents,
            stats: options.parser.stats,
            leftovers,
            groupGone: gone,
          })
        })
    }
    giveUp = () => {
      if (closed) return
      leaderExited = true
      // The pipes stay open (closing them could end a CLI we are not allowed to signal) but nothing more is read.
      abandoned = true
      closed = true
      settle()
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
      // The launcher could not execute the CLI (missing binary, no permission): the same as a failed spawn.
      if (code === 127 && stderr.startsWith('pdeathsig-exec: cannot run'))
        spawnError = 'exec_failed'
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
      if (stopped === null) {
        stopped = 'shutdown'
        recordStop('shutdown')
      }
      signal('SIGKILL')
      throw new SpawnRecordError(
        error,
        done.then((outcome) => outcome.groupGone),
      )
    }
  }
  if (child.pid !== undefined) release()
  return { stop, pid: child.pid, done }
}
