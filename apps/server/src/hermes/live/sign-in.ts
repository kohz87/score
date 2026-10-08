import { randomBytes } from 'node:crypto'
import type { SignIn } from '@score/contract'
import { HttpError } from '../../errors.ts'
import type { HermesChild, HermesSpawner } from './cli.ts'

// Device-code sign-in (ARCHITECTURE D2.7). Score runs `hermes auth add <id> --type oauth --no-browser` detached,
// reads only the verification link and user code from its first output, and watches the process. Tokens go from the
// provider to Hermes; Score never sees them, and nothing else the process prints is kept or logged.
const MAX_OUTPUT = 16 * 1024
const PARSE_TIMEOUT_MS = 30_000
const EXPIRY_MS = 15 * 60_000
const KEEP_FINISHED_MS = 60 * 60_000
const MAX_ENTRIES = 50
const GENERIC_FAILURE = 'The sign-in did not finish. You can run it in a terminal instead.'

// Terminal control sequences (CSI and OSC), so colored output parses like plain text.
// eslint-disable-next-line no-control-regex -- matching the ESC and BEL control characters is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./g
const URL_IN_LINE = /https:\/\/[^\s'"<>)\]]+/
const CODE_LINE = /\bcode\b[^:\n]*:[ \t]*(\S[^\n]*)?$/i
const CODE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 -]{2,62}$/

/**
 * The link and code from a device-code login's output, or null while either is missing. Hermes prints
 * "1. Open: <url>" / "2. If prompted, enter code: <code>" (Nous, xAI, MiniMax: `_print_device_code_instructions`
 * in hermes_cli/auth_device_flow.py) and, for Codex, the URL and the code each on the line after their prompt
 * (`_codex_device_code_login` in hermes_cli/auth_codex.py). "Portal:" lines earlier in the output are skipped
 * because the link is only taken at or after the "Open" instruction.
 */
export function parseDeviceCode(output: string): { url: string; code: string } | null {
  const lines = output.replace(ANSI, '').split(/\r?\n/)
  let url: string | undefined
  let opened = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (url === undefined) {
      if (/\bopen\b/i.test(line)) opened = true
      const found = opened ? URL_IN_LINE.exec(line)?.[0] : undefined
      if (found) {
        try {
          if (new URL(found).protocol === 'https:') url = found
        } catch {
          // Not a link.
        }
      }
      continue
    }
    const match = CODE_LINE.exec(line.trimEnd())
    if (!match) continue
    // Codex puts the code alone on the next non-empty line.
    let value = match[1]?.trim()
    if (!value) {
      for (let j = i + 1; j < lines.length && !value; j++) value = lines[j]!.trim() || undefined
    }
    if (value && CODE_VALUE.test(value)) return { url, code: value }
  }
  return null
}

interface Entry {
  signIn: SignIn
  child: HermesChild | undefined
  /** Settles once the link and code are known, or the attempt failed. */
  ready: Promise<void>
  timers: NodeJS.Timeout[]
  finishedAt: number | undefined
}
export interface SignInDeps {
  spawn: HermesSpawner
  hermesHome: string | undefined
  /** Profile arguments (`['-p', name]`) or none: whose credentials the sign-in is for. */
  profileArgs: string[]
  /** Re-reads `hermes auth list`: is the provider connected now? */
  isConnected: (providerId: string) => Promise<boolean>
  clock?: () => number
  parseTimeoutMs?: number
  expiryMs?: number
}

export class SignInManager {
  private readonly entries = new Map<string, Entry>()
  private readonly clock: () => number
  constructor(private readonly deps: SignInDeps) {
    this.clock = deps.clock ?? Date.now
  }

  /** Starts the sign-in, or returns the one already waiting for this provider. */
  async start(providerId: string): Promise<SignIn> {
    for (const entry of this.entries.values()) {
      if (entry.signIn.providerId === providerId && entry.signIn.state === 'waiting') {
        await entry.ready
        return { ...entry.signIn }
      }
    }
    this.prune()
    const now = this.clock()
    const signIn: SignIn = {
      id: randomBytes(16).toString('hex'),
      providerId,
      state: 'waiting',
      url: null,
      code: null,
      expiresAt: new Date(now + (this.deps.expiryMs ?? EXPIRY_MS)).toISOString(),
      message: null,
    }
    const entry: Entry = {
      signIn,
      child: undefined,
      ready: Promise.resolve(),
      timers: [],
      finishedAt: undefined,
    }
    this.entries.set(signIn.id, entry)
    entry.ready = new Promise<void>((resolveReady) => {
      let buffer = ''
      let parsed = false
      const settle = () => resolveReady()
      const fail = (state: 'failed' | 'expired' | 'cancelled', message: string | null) => {
        this.finish(entry, state, message)
        settle()
      }
      try {
        entry.child = this.deps.spawn(
          [...this.deps.profileArgs, 'auth', 'add', providerId, '--type', 'oauth', '--no-browser'],
          {
            hermesHome: this.deps.hermesHome,
            onStdout: (chunk) => {
              if (parsed) return
              buffer = (buffer + chunk).slice(0, MAX_OUTPUT)
              const found = parseDeviceCode(buffer)
              if (!found || entry.signIn.state !== 'waiting') return
              parsed = true
              buffer = ''
              entry.signIn.url = found.url
              entry.signIn.code = found.code
              settle()
            },
          },
        )
      } catch {
        fail('failed', GENERIC_FAILURE)
        return
      }
      const child = entry.child
      entry.timers.push(
        setTimeout(() => {
          if (!parsed && entry.signIn.state === 'waiting') {
            child.kill()
            fail('failed', GENERIC_FAILURE)
          }
        }, this.deps.parseTimeoutMs ?? PARSE_TIMEOUT_MS),
        setTimeout(() => {
          if (entry.signIn.state !== 'waiting') return
          child.kill()
          fail('expired', 'The code expired. Start the sign-in again.')
        }, this.deps.expiryMs ?? EXPIRY_MS),
      )
      for (const timer of entry.timers) timer.unref()
      void child.exited.then(async (code) => {
        if (entry.signIn.state !== 'waiting') return
        // Only Hermes's own credential list says whether it worked, never the exit code or the output alone.
        let connected = false
        if (code === 0) connected = await this.deps.isConnected(providerId).catch(() => false)
        if (entry.signIn.state !== 'waiting') return
        if (connected) this.finish(entry, 'connected', null)
        else this.finish(entry, 'failed', GENERIC_FAILURE)
        settle()
      })
    })
    await entry.ready
    return { ...entry.signIn }
  }

  get(id: string): SignIn {
    return { ...this.entry(id).signIn }
  }

  cancel(id: string): SignIn {
    const entry = this.entry(id)
    if (entry.signIn.state === 'waiting') {
      entry.child?.kill()
      this.finish(entry, 'cancelled', null)
    }
    return { ...entry.signIn }
  }

  /** Kills every child still running (server close). */
  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.signIn.state === 'waiting') {
        entry.child?.kill()
        this.finish(entry, 'cancelled', null)
      }
      for (const timer of entry.timers) clearTimeout(timer)
    }
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new HttpError(404, 'not_found', 'Unknown sign-in')
    return entry
  }
  private finish(entry: Entry, state: SignIn['state'], message: string | null): void {
    for (const timer of entry.timers) clearTimeout(timer)
    entry.signIn.state = state
    entry.signIn.message = message
    // The code is only useful while waiting.
    entry.signIn.url = null
    entry.signIn.code = null
    entry.finishedAt = this.clock()
  }
  private prune(): void {
    const cutoff = this.clock() - KEEP_FINISHED_MS
    for (const [id, entry] of this.entries)
      if (entry.finishedAt !== undefined && entry.finishedAt < cutoff) this.entries.delete(id)
    for (const [id, entry] of this.entries) {
      if (this.entries.size < MAX_ENTRIES) break
      if (entry.finishedAt !== undefined) this.entries.delete(id)
    }
  }
}
