import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { arch, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { codexDriver } from '../../src/runtimes/coding/codex.ts'
import { spawnCli } from '../../src/runtimes/coding/process.ts'

// AA2 (7.7a v5 review #2): the fallback runs the CLI's real native executable, or refuses.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-native-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const triple = arch() === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
const locatorFor = (bin: string) =>
  new CliLocator({ env: { PATH: bin } as NodeJS.ProcessEnv, cacheMs: 0 })

/** A harmless "native" executable: a copy of /bin/sleep (an ELF). */
const nativeCopy = (to: string) => {
  mkdirSync(join(to, '..'), { recursive: true })
  copyFileSync(realpathSync('/bin/sleep'), to)
  chmodSync(to, 0o755)
}

/** A launcher script that spawns a sleeper, as the npm Codex wrapper spawns its engine. */
const spawningLauncher = (to: string) => {
  mkdirSync(join(to, '..'), { recursive: true })
  writeFileSync(to, '#!/bin/sh\n/bin/sleep 30 &\nwait\n', { mode: 0o755 })
}

test('AA2: a spawning launcher script without a known native path is refused', () => {
  const bin = join(dir, 'bin')
  spawningLauncher(join(bin, 'codex'))
  const result = locatorFor(bin).nativeCommand(codexDriver)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.message).toMatch(/launcher Score can't supervise without systemd/)
})

test('AA2: a native ELF on PATH is accepted as its real path', () => {
  const bin = join(dir, 'bin')
  nativeCopy(join(dir, 'real', 'codex-real'))
  mkdirSync(bin)
  symlinkSync(join(dir, 'real', 'codex-real'), join(bin, 'codex'))
  const result = locatorFor(bin).nativeCommand(codexDriver)
  expect(result).toEqual({ ok: true, file: realpathSync(join(bin, 'codex')), args: [] })
})

test('AA2: the npm Codex layout resolves to the package vendor/<target>/codex/codex', () => {
  const pkg = join(dir, 'lib', 'node_modules', '@openai', 'codex')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  const native = join(pkg, 'vendor', triple, 'codex', 'codex')
  nativeCopy(native)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  symlinkSync(join(pkg, 'bin', 'codex.js'), join(bin, 'codex'))
  const result = locatorFor(bin).nativeCommand(codexDriver)
  expect(result).toEqual({ ok: true, file: realpathSync(native), args: [] })
})

test('AA2: an npm layout with no native binary in the package is refused', () => {
  const pkg = join(dir, 'lib', 'node_modules', '@openai', 'codex')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  symlinkSync(join(pkg, 'bin', 'codex.js'), join(bin, 'codex'))
  expect(locatorFor(bin).nativeCommand(codexDriver).ok).toBe(false)
})

test('AA2: the resolved native path is what the fallback execs (no launcher in between)', async () => {
  const pkg = join(dir, 'lib', 'node_modules', '@openai', 'codex')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  // Node stands in for the engine (a coreutils copy would be a multi-call binary that refuses its new name).
  const vendor = join(pkg, 'vendor', triple, 'codex')
  mkdirSync(vendor, { recursive: true })
  symlinkSync(process.execPath, join(vendor, 'codex'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  symlinkSync(join(pkg, 'bin', 'codex.js'), join(bin, 'codex'))
  const resolved = locatorFor(bin).nativeCommand(codexDriver)
  if (!resolved.ok) throw new Error('not resolved')
  const run = spawnCli({
    file: resolved.file,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: dir,
    env: { PATH: '' },
    stdin: '',
    parser: { parse: () => [], stats: { unknown: 0, malformed: 0 } },
    onEvent: async () => undefined,
    graceMs: 50,
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 500))
    // The leader's executable is the native binary itself, so PDEATHSIG protects the engine.
    expect(readlinkSync(`/proc/${run.pid}/exe`)).toBe(resolved.file)
  } finally {
    run.stop('shutdown')
    await run.done
  }
})

// EE2 (7.7a v6 review #2): no PATH, an empty PATH or relative components never yield a bare command name.
test('EE2: an absent, empty or relative-only PATH refuses instead of returning a bare name', () => {
  for (const env of [{}, { PATH: '' }, { PATH: ':' }, { PATH: 'bin:./bin:.' }]) {
    const locator = new CliLocator({ env: env as NodeJS.ProcessEnv, cacheMs: 0 })
    const result = locator.nativeCommand(codexDriver)
    expect(result.ok).toBe(false)
  }
})

test('EE2: a relative PATH component is not searched even when it holds a native codex', () => {
  const bin = join(dir, 'bin')
  nativeCopy(join(bin, 'codex'))
  const previous = process.cwd()
  process.chdir(dir)
  try {
    expect(locatorFor('bin').nativeCommand(codexDriver).ok).toBe(false)
    expect(locatorFor(`bin:${bin}`).nativeCommand(codexDriver).ok).toBe(true)
  } finally {
    process.chdir(previous)
  }
})

test('EE2: version detection uses the same search, so an absent PATH reports not installed', async () => {
  const locator = new CliLocator({ env: {} as NodeJS.ProcessEnv, cacheMs: 0 })
  expect((await locator.detect(codexDriver)).state).toBe('not_installed')
})

test('EE2: the wrapper execs an absolute path only (a bare name on the default path is not run)', async () => {
  const run = spawnCli({
    file: 'sleep', // on every default PATH; the old execvp would have run it
    args: ['0.1'],
    cwd: dir,
    env: {}, // no PATH at all: the old execvp fell back to its own default path
    stdin: '',
    parser: { parse: () => [], stats: { unknown: 0, malformed: 0 } },
    onEvent: async () => undefined,
    graceMs: 50,
  })
  const outcome = await run.done
  expect(JSON.stringify(outcome)).toMatch(/exec_failed/)
})

// EE4: the pinned npm Codex layout.
const launcherPackage = (base: string) => {
  const pkg = join(base, 'node_modules', '@openai', 'codex')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  symlinkSync(join(pkg, 'bin', 'codex.js'), join(bin, 'codex'))
  return { pkg, bin }
}
const platform = arch() === 'arm64' ? 'linux-arm64' : 'linux-x64'

test('EE4: the optional platform package layout (vendor/<target>/bin/codex) resolves', () => {
  const { pkg, bin } = launcherPackage(join(dir, 'lib'))
  const native = join(pkg, '..', `codex-${platform}`, 'vendor', triple, 'bin', 'codex')
  nativeCopy(native)
  const result = locatorFor(bin).nativeCommand(codexDriver)
  expect(result).toEqual({ ok: true, file: realpathSync(native), args: [] })
})

test('EE4: the package-local fallback layout (vendor/<target>/bin/codex) resolves', () => {
  const { pkg, bin } = launcherPackage(join(dir, 'lib'))
  const native = join(pkg, 'vendor', triple, 'bin', 'codex')
  nativeCopy(native)
  const result = locatorFor(bin).nativeCommand(codexDriver)
  expect(result).toEqual({ ok: true, file: realpathSync(native), args: [] })
})
