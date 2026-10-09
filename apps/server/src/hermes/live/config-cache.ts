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
  const drop = (home: string) => {
    generation.set(home, gen(home) + 1)
    for (const key of [...entries.keys()]) if (key.startsWith(`${home}\0`)) entries.delete(key)
  }

  return async (args, options) => {
    const shape = readShape(args)
    if (!shape) {
      const first = args[0] === '-p' ? args[2] : args[0]
      const writes = first !== undefined && WRITING.has(first)
      const home = (profile: string) => profileHome(hermesHome, profile)
      const profile = args[0] === '-p' && args[1] ? args[1] : 'default'
      if (writes) drop(home(profile))
      try {
        return await inner(args, options)
      } finally {
        // Again afterwards: a read that started during the write must not be stored as current.
        if (writes) drop(home(profile))
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
