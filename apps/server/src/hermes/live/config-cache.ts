import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ProfileNameSchema } from './paths.ts'
import { type HermesRunner } from './cli.ts'

// Every `hermes` call costs 2+ seconds here, and almost all reads Score makes are answers derived from one
// profile's config.yaml. This wraps the runner: an allowlisted read is answered from memory while config.yaml's
// stat signature (mtime, size, inode) is unchanged. Score never parses the file; the signature only says
// "same as when the CLI last answered". A Score-side change to config, plugins, tools or skills drops the
// profile's entries, an outside edit changes the signature, and failed reads are never stored (so they retry).
type Result = Awaited<ReturnType<HermesRunner>>
interface Entry {
  signature: string
  result: Result
}

/** The profile and the argv after `-p <name>` when this call is a cacheable read; null otherwise. */
function readShape(argv: string[]): { profile: string; rest: string[] } | null {
  const scoped = argv[0] === '-p' && ProfileNameSchema.safeParse(argv[1]).success
  const rest = scoped ? argv.slice(2) : argv
  const profile = scoped ? argv[1]! : 'default'
  const text = rest.slice(0, 3).join(' ')
  if (text === 'config get --json' && rest.length === 4) return { profile, rest }
  if (rest.join(' ') === 'plugins list --json') return { profile, rest }
  if (text === 'tools list --platform' && rest.length === 4) return { profile, rest }
  return null
}
/** The key of a `[-p name] config set <key> <value>` call; null for every other command. */
function configSetKey(argv: string[]): string | null {
  const rest = argv[0] === '-p' ? argv.slice(2) : argv
  return rest[0] === 'config' && rest[1] === 'set' && rest.length === 4 && rest[2] ? rest[2] : null
}
/** The config key a cached `config get --json <key>` entry answers; null for other reads (plugins, tools). */
function readKeyOf(cacheKey: string): string | null {
  const argv = cacheKey.split('\0')[1]?.split('\u0001') ?? []
  const rest = argv[0] === '-p' ? argv.slice(2) : argv
  return rest.slice(0, 3).join(' ') === 'config get --json' ? (rest[3] ?? null) : null
}
/** Whether a write to `written` can change the answer for `read` (same key, or one contains the other). */
function relatedKey(read: string | null, written: string): boolean {
  if (read === null) return true
  const a = read.toLowerCase()
  const b = written.toLowerCase()
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}
const WRITING = new Set(['config', 'plugins', 'tools', 'skills', 'profile', 'auth', 'mcp', 'model'])

function profileHome(hermesHome: string, profile: string): string {
  // A home that already is a profile directory is that profile (see pinScope in cli.ts).
  if (basename(dirname(hermesHome)) === 'profiles') return hermesHome
  return profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
}
function signatureOf(home: string): string | null {
  try {
    const stat = fs.lstatSync(join(home, 'config.yaml'))
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}:${stat.ino}` : null
  } catch {
    return null
  }
}

export function cachingRunner(inner: HermesRunner, hermesHome: string): HermesRunner {
  const entries = new Map<string, Entry>()
  const pending = new Map<string, Promise<Result>>()
  const generation = new Map<string, number>()
  const gen = (home: string) => generation.get(home) ?? 0
  // `clear: false` only fences reads that are still in flight; stored answers are left alone.
  const drop = (home: string, clear = true) => {
    generation.set(home, gen(home) + 1)
    if (clear)
      for (const key of [...entries.keys()]) if (key.startsWith(`${home}\0`)) entries.delete(key)
  }

  return async (args, options) => {
    const shape = readShape(args)
    if (!shape) {
      const first = args[0] === '-p' ? args[2] : args[0]
      const writes = first !== undefined && WRITING.has(first)
      const home = (profile: string) => profileHome(hermesHome, profile)
      const profile = args[0] === '-p' && args[1] ? args[1] : 'default'
      if (!writes) return inner(args, options)
      const target = home(profile)
      const setKey = configSetKey(args)
      // `config set K` rewrites config.yaml but leaves every other key as it was: answers for unrelated keys that were
      // current just before the write stay current after it (re-signed below) instead of costing a CLI call each.
      const before = setKey === null ? null : signatureOf(target)
      const keep =
        before === null
          ? []
          : [...entries].filter(
              ([key, entry]) =>
                key.startsWith(`${target}\0`) &&
                entry.signature === before &&
                !relatedKey(readKeyOf(key), setKey!),
            )
      drop(target)
      try {
        const result = await inner(args, options)
        const after = signatureOf(target)
        if (result.exitCode === 0 && after !== null)
          for (const [key, entry] of keep) entries.set(key, { ...entry, signature: after })
        return result
      } finally {
        // Again afterwards: a read that started during the write must not be stored as current.
        drop(target, false)
      }
    }
    const home = profileHome(hermesHome, shape.profile)
    const signature = signatureOf(home)
    if (
      signature === null ||
      !(options.captureRead || options.captureModel || options.captureSettings)
    )
      return inner(args, options)
    const key = `${home}\0${args.join('\u0001')}\0${options.captureModel ? 'm' : ''}`
    const hit = entries.get(key)
    if (hit?.signature === signature) return hit.result
    const flightKey = `${key}\0${signature}`
    const flying = pending.get(flightKey)
    if (flying) return flying
    const started = gen(home)
    const run = inner(args, options)
      .then((result) => {
        // Exit 1 is Hermes saying "key never set"; that is an answer too. Timeouts and signals are not.
        if ((result.exitCode === 0 || result.exitCode === 1) && gen(home) === started)
          entries.set(key, { signature, result })
        return result
      })
      .finally(() => pending.delete(flightKey))
    pending.set(flightKey, run)
    return run
  }
}
