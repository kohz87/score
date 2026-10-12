import { readFileSync } from 'node:fs'
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { HttpError } from '../errors.ts'

// Linux renameat2(RENAME_NOREPLACE) through a tiny stdlib-only Python helper (same pattern as
// runtimes/coding/pidfd-signal): one kernel call that creates the destination or fails with EEXIST, and never
// deletes anything. There is deliberately no fallback to a replacing rename or a link-and-unlink protocol.

const SCRIPT = fileURLToPath(new URL('./rename-noreplace.py', import.meta.url))

export interface RenameSupport {
  python: string | null
  detail: string
}

let cached: RenameSupport | undefined

/** Probes `python3` (or `SCORE_PYTHON`) for renameat2 once. */
export function renameSupport(candidate = process.env.SCORE_PYTHON || 'python3'): RenameSupport {
  if (candidate === (process.env.SCORE_PYTHON || 'python3') && cached) return cached
  let found: RenameSupport
  try {
    execFileSync(candidate, ['-I', SCRIPT, '--probe'], { stdio: 'ignore', timeout: 5000 })
    found = { python: candidate, detail: `atomic no-replace rename via ${candidate}` }
  } catch {
    found = {
      python: null,
      detail: `${candidate} can't do an atomic no-replace rename (needs Linux and python3)`,
    }
  }
  if (candidate === (process.env.SCORE_PYTHON || 'python3')) cached = found
  return found
}

/** Test hook: forget the probe result. */
export function resetRenameSupport(): void {
  cached = undefined
}

const unsupported = () =>
  new HttpError(
    500,
    'rename_unsupported',
    'Couldn’t move that file. Knowledge needs Linux with python3 and a filesystem that supports an atomic no-replace rename.',
  )

/**
 * One long-lived helper per interpreter answers every move in order (a bulk unzip would otherwise start a Python per
 * file). It ends with Score: its stdin closes. If it dies or hangs, the requests waiting for it get "unknown outcome"
 * and the next move starts a new one.
 */
class Server {
  private child: ChildProcessByStdio<Writable, Readable, null> | undefined
  // Each helper has its own queue and read buffer: a dead helper's cleanup must never touch its replacement's requests.
  private readonly queues = new WeakMap<
    ChildProcessByStdio<Writable, Readable, null>,
    { waiting: Array<{ resolve: (code: number) => void; timer: NodeJS.Timeout }>; buffer: string }
  >()

  constructor(private readonly python: string) {}

  private start(): ChildProcessByStdio<Writable, Readable, null> {
    const child = spawn(this.python, ['-I', SCRIPT, '--serve'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const queue = {
      waiting: [] as Array<{ resolve: (code: number) => void; timer: NodeJS.Timeout }>,
      buffer: '',
    }
    this.queues.set(child, queue)
    child.unref()
    // The pipes must not keep Node alive either.
    ;(child.stdin as unknown as { unref?: () => void }).unref?.()
    ;(child.stdout as unknown as { unref?: () => void }).unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      queue.buffer += chunk
      for (let end = queue.buffer.indexOf('\n'); end >= 0; end = queue.buffer.indexOf('\n')) {
        const line = queue.buffer.slice(0, end)
        queue.buffer = queue.buffer.slice(end + 1)
        const entry = queue.waiting.shift()
        if (!entry) continue
        clearTimeout(entry.timer)
        try {
          const code: unknown = (JSON.parse(line) as { code?: unknown }).code
          entry.resolve(typeof code === 'number' ? code : 5)
        } catch {
          entry.resolve(5)
        }
      }
    })
    const gone = () => {
      if (this.child === child) this.child = undefined
      queue.buffer = ''
      for (const entry of queue.waiting.splice(0)) {
        clearTimeout(entry.timer)
        entry.resolve(5)
      }
    }
    child.on('exit', gone)
    child.on('error', gone)
    child.stdin.on('error', () => undefined)
    return child
  }

  private busy(child: ChildProcessByStdio<Writable, Readable, null>): void {
    child.ref()
    ;(child.stdout as unknown as { ref?: () => void }).ref?.()
  }

  private idle(child: ChildProcessByStdio<Writable, Readable, null>): void {
    child.unref()
    ;(child.stdout as unknown as { unref?: () => void }).unref?.()
  }

  request(source: string, dest: string, retried = false): Promise<number> {
    return new Promise<number>((resolve) => {
      // Node learns of a dead helper asynchronously; the kernel knows now (a reaped child fails signal 0).
      const alive = (c: ChildProcessByStdio<Writable, Readable, null>) => {
        if (
          c.exitCode !== null ||
          c.signalCode !== null ||
          c.stdin.destroyed ||
          c.pid === undefined
        )
          return false
        try {
          process.kill(c.pid, 0)
        } catch {
          return false
        }
        // A helper that died but isn't reaped yet still answers signal 0: it is a zombie and will never reply.
        try {
          const stat = readFileSync(`/proc/${c.pid}/stat`, 'utf8')
          return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
        } catch {
          return false
        }
      }
      if (this.child && !alive(this.child)) this.child = undefined
      const child = (this.child ??= this.start())
      const queue = this.queues.get(child)!
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      timer.unref()
      const entry = {
        resolve: (code: number) => {
          // Keep Node alive only while a request is outstanding; an idle helper never holds the process open.
          if (queue.waiting.length === 0) this.idle(child)
          resolve(code)
        },
        timer,
      }
      this.busy(child)
      queue.waiting.push(entry)
      child.stdin.write(`${JSON.stringify({ from: source, to: dest })}\n`, (error) => {
        if (!error || retried) return
        // The helper was already gone: the request never reached it, so nothing was renamed and sending it once more,
        // to a fresh helper, is safe.
        const at = queue.waiting.indexOf(entry)
        if (at >= 0) queue.waiting.splice(at, 1)
        clearTimeout(timer)
        if (this.child === child) this.child = undefined
        resolve(this.request(source, dest, true))
      })
    })
  }
}

const servers = new Map<string, Server>()

/**
 * Moves `source` to `dest` atomically without replacing anything. 404 when the source is gone, 409 when the
 * destination exists (both files untouched), a plain refusal when this system can't do it.
 */
export async function renameNoReplace(
  source: string,
  dest: string,
  python: string | null = renameSupport().python,
): Promise<void> {
  if (python === null) throw unsupported()
  let server = servers.get(python)
  if (!server) servers.set(python, (server = new Server(python)))
  const code = await server.request(source, dest)
  if (code === 0) return
  if (code === 17) throw new HttpError(409, 'exists', 'A file with that name already exists.')
  if (code === 2) throw new HttpError(404, 'not_found', 'Couldn’t find that file.')
  if (code === 22 || code === 95) throw unsupported()
  throw new HttpError(500, 'move_failed', 'Couldn’t move that file.')
}
