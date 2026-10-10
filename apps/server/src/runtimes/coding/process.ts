import { spawn } from 'node:child_process'
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
  /** Whether the CLI printed any line we understood. */
  sawEvents: boolean
  stats: LineParser['stats']
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
  /** Called synchronously right after the spawn, before any output is read (records the process durably). */
  onSpawn?(pid: number): void
  maxMs?: number
  graceMs?: number
}

/**
 * One CLI process per turn: argv only (no shell), the prompt on stdin, JSON lines on stdout. Output is capped, a
 * turn has a wall-clock limit, and Stop escalates SIGINT -> SIGTERM -> SIGKILL.
 */
export function spawnCli(options: SpawnOptions): CliRun {
  const { maxMs = CODING_LIMITS.maxTurnMs, graceMs = CODING_LIMITS.stopGraceMs } = options
  let stopped: StopReason | null = null
  let spawnError: string | null = null
  let sawEvents = false
  let stderr = ''
  let total = 0
  let buffered = ''
  let skipping = false
  let queue: Promise<void> = Promise.resolve()
  const timers: NodeJS.Timeout[] = []

  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group, so Stop reaches the tools the CLI started too.
    detached: true,
  })
  if (child.pid !== undefined) options.onSpawn?.(child.pid)
  const signal = (name: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, name)
    } catch {
      try {
        child.kill(name)
      } catch {
        // already gone
      }
    }
  }
  function stop(reason: StopReason = 'user'): void {
    if (stopped !== null || child.exitCode !== null || child.signalCode !== null) return
    stopped = reason
    signal('SIGINT')
    const term = setTimeout(() => signal('SIGTERM'), graceMs)
    const kill = setTimeout(() => signal('SIGKILL'), graceMs * 2)
    term.unref()
    kill.unref()
    timers.push(term, kill)
  }
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
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-CODING_LIMITS.stderrBytes)
  })
  // The CLI may exit without reading all of stdin.
  child.stdin.on('error', () => undefined)
  child.stdin.end(options.stdin)

  const done = new Promise<CliOutcome>((resolve) => {
    let settled = false
    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (!skipping && buffered.trim() && Buffer.byteLength(buffered) <= CODING_LIMITS.maxLineBytes)
        handleLine(buffered)
      void queue.then(() =>
        resolve({
          exitCode,
          signal: exitSignal,
          stopped,
          stderr,
          spawnError,
          sawEvents,
          stats: options.parser.stats,
        }),
      )
    }
    child.on('error', (error) => {
      spawnError = (error as NodeJS.ErrnoException).code ?? 'spawn_failed'
      finish(null, null)
    })
    child.on('close', finish)
  })
  return { stop, pid: child.pid, done }
}
