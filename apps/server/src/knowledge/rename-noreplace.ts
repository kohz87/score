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
  private waiting: Array<{ resolve: (code: number) => void; timer: NodeJS.Timeout }> = []
  private buffer = ''

  constructor(private readonly python: string) {}

  private start(): ChildProcessByStdio<Writable, Readable, null> {
    const child = spawn(this.python, ['-I', SCRIPT, '--serve'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    child.unref()
    // The pipes must not keep Node alive either.
    ;(child.stdin as unknown as { unref?: () => void }).unref?.()
    ;(child.stdout as unknown as { unref?: () => void }).unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        const entry = this.waiting.shift()
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
      this.buffer = ''
      for (const entry of this.waiting.splice(0)) {
        clearTimeout(entry.timer)
        entry.resolve(5)
      }
    }
    child.on('exit', gone)
    child.on('error', gone)
    child.stdin.on('error', () => undefined)
    return child
  }

  request(source: string, dest: string): Promise<number> {
    return new Promise<number>((resolve) => {
      const child = (this.child ??= this.start())
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      timer.unref()
      this.waiting.push({ resolve, timer })
      child.stdin.write(`${JSON.stringify({ from: source, to: dest })}\n`)
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
