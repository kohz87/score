import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { arch } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { CodingRuntime } from '@score/contract'

// The fallback protects the process it execs with PR_SET_PDEATHSIG, and the flag is cleared for that process's
// children. A launcher (a script, or a Node wrapper that spawns the engine) would die with Score while the engine it
// started kept working, so the fallback only ever runs the CLI's real native executable (7.7a v5 review #2).

export type NativeResolution = { ok: true; file: string } | { ok: false; message: string }

const refusal = (label: string): NativeResolution => ({
  ok: false,
  message: `This ${label} install starts its engine through a launcher Score can't supervise without systemd units; install the standalone ${label} or enable systemd user services.`,
})

type Kind = 'elf' | 'script' | 'other'
function kindOf(path: string): Kind {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    const read = readSync(fd, head, 0, 4, 0)
    if (read >= 4 && head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') return 'elf'
    if (read >= 2 && head.toString('latin1', 0, 2) === '#!') return 'script'
    return 'other'
  } catch {
    return 'other'
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function findOnPath(file: string, pathVar: string | undefined): string | null {
  const candidates = isAbsolute(file)
    ? [file]
    : (pathVar ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, file))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return realpathSync(candidate)
    } catch {
      // next
    }
  }
  return null
}

/** Rust target triples of the npm Codex package for this machine, most likely first. */
function codexTriples(): { triple: string; platform: string }[] {
  const x64 = [
    { triple: 'x86_64-unknown-linux-musl', platform: 'linux-x64' },
    { triple: 'x86_64-unknown-linux-gnu', platform: 'linux-x64' },
  ]
  const arm = [
    { triple: 'aarch64-unknown-linux-musl', platform: 'linux-arm64' },
    { triple: 'aarch64-unknown-linux-gnu', platform: 'linux-arm64' },
  ]
  return arch() === 'arm64' ? arm : arch() === 'x64' ? x64 : []
}

/** Codex npm layout: the package that owns the launcher holds `vendor/<target>/codex/codex` (or a platform package does). */
function codexNative(launcher: string): string | null {
  let dir = dirname(launcher)
  for (let depth = 0; depth < 6; depth++) {
    if (isCodexPackage(dir)) {
      for (const { triple, platform } of codexTriples()) {
        for (const base of [dir, join(dir, 'node_modules', '@openai', `codex-${platform}`)]) {
          const candidate = join(base, 'vendor', triple, 'codex', 'codex')
          try {
            const real = realpathSync(candidate)
            if (kindOf(real) === 'elf') return real
          } catch {
            // next
          }
        }
      }
      return null
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function isCodexPackage(dir: string): boolean {
  try {
    const raw = readPackageName(join(dir, 'package.json'))
    return raw === '@openai/codex'
  } catch {
    return false
  }
}

function readPackageName(path: string): string | undefined {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }
  return typeof parsed.name === 'string' ? parsed.name : undefined
}

/**
 * The executable the fallback may run for `file`: its real path when that is a native binary, the package's native
 * binary when a known npm launcher fronts it, otherwise a refusal.
 */
export function resolveNativeExecutable(
  runtime: CodingRuntime,
  label: string,
  file: string,
  pathVar: string | undefined,
): NativeResolution {
  const real = findOnPath(file, pathVar)
  if (real === null) return { ok: true, file } // not found: the launch reports it as it always did
  const kind = kindOf(real)
  if (kind === 'elf') return { ok: true, file: real }
  if (kind === 'script' && runtime === 'codex') {
    const native = codexNative(real)
    if (native) return { ok: true, file: native }
  }
  return refusal(label)
}
