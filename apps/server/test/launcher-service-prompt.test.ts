import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  alive,
  calls,
  installEnv,
  makeRig,
  pidOf,
  QUESTION,
  remembered,
  score,
  scoreOnTerminal,
  spawned,
  type Rig,
} from './launcher-service-helpers.ts'

test('prompt: yes (Enter) installs the service and does nothing else', async () => {
  const rig = makeRig()
  const result = await scoreOnTerminal(rig, ['start'], [''], installEnv)
  expect(result.asked).toBe(1)
  expect(result.code).toBe(0)
  expect(result.out).toMatch(/Wrote .*score\.env/)
  expect(result.out).toMatch(/Pair this browser: http:\/\/127\.0\.0\.1:1\/pair#TOKEN/)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(true)
  expect(calls(rig)).toMatch(/enable --now score/)
  expect(calls(rig)).not.toMatch(/--user start score/)
  expect(existsSync(remembered(rig))).toBe(false)
  expect((result.out.match(/Score started/g) ?? []).length).toBe(1)
  console.log(`--- prompt, answer Enter ---\n${result.out}`)
}, 60_000)

test('prompt: "y" and "yes" also install', async () => {
  for (const answer of ['y', 'YES']) {
    const rig = makeRig()
    const result = await scoreOnTerminal(rig, ['start'], [answer], installEnv)
    expect(result.code).toBe(0)
    expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(true)
  }
}, 90_000)

test('prompt: no is remembered (0600, "declined <date>"), starts normally, and is never asked again', async () => {
  const rig = makeRig()
  const result = await scoreOnTerminal(rig, ['start'], ['n'], installEnv)
  expect(result.asked).toBe(1)
  expect(result.code).toBe(0)
  expect(result.out).toMatch(
    /Not installed\. 'scripts\/score service install' does it later\.[\s\S]*Score started/,
  )
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(false)
  expect(readFileSync(remembered(rig), 'utf8')).toMatch(/^declined \d{4}-\d{2}-\d{2}T[\d:.]+Z\n?$/)
  expect(statSync(remembered(rig)).mode & 0o777).toBe(0o600)
  expect(calls(rig)).not.toMatch(/enable/)
  console.log(`--- prompt, answer n ---\n${result.out}`)
  await score(rig, ['stop'])
  const again = await scoreOnTerminal(rig, ['start'], [], installEnv)
  expect(again.asked).toBe(0)
  expect(again.out).toMatch(/Score started/)
  await score(rig, ['stop'])
}, 90_000)

test('prompt: other answers ask again, three in all, then start without remembering', async () => {
  const rig = makeRig()
  const result = await scoreOnTerminal(rig, ['start'], ['maybe', '?', 'what'], installEnv)
  expect(result.asked).toBe(3)
  expect(result.code).toBe(0)
  expect(result.out).toMatch(/Score started/)
  expect(existsSync(remembered(rig))).toBe(false)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(false)
  await score(rig, ['stop'])
}, 60_000)

test('prompt: service install clears a remembered no; uninstall leaves it alone', async () => {
  const rig = makeRig()
  mkdirSync(rig.home, { recursive: true })
  writeFileSync(remembered(rig), 'declined 2026-10-20T00:00:00Z\n', { mode: 0o600 })
  expect((await score(rig, ['service', 'install'], installEnv)).code).toBe(0)
  expect(existsSync(remembered(rig))).toBe(false)
  writeFileSync(remembered(rig), 'declined 2026-10-20T00:00:00Z\n', { mode: 0o600 })
  expect((await score(rig, ['service', 'uninstall'])).code).toBe(0)
  expect(existsSync(remembered(rig))).toBe(true)
}, 90_000)

test('prompt: never without a terminal, with SCORE_NO_SERVICE_PROMPT, with an unreachable manager or an installed unit', async () => {
  const plain = makeRig()
  const piped = await score(plain, ['start'], installEnv)
  expect(piped.out).not.toContain(QUESTION)
  expect(piped.out).toMatch(/Score started/)
  expect(calls(plain)).toBe('')
  await score(plain, ['stop'])

  const quiet = makeRig()
  const opted = await scoreOnTerminal(quiet, ['start'], [], {
    ...installEnv,
    SCORE_NO_SERVICE_PROMPT: '1',
  })
  expect(opted.asked).toBe(0)
  expect(opted.out).toMatch(/Score started/)
  expect(existsSync(remembered(quiet))).toBe(false)
  await score(quiet, ['stop'])

  const down = makeRig({ FAKE_NO_MANAGER: '1' })
  const unreachable = await scoreOnTerminal(down, ['start'], [], installEnv)
  expect(unreachable.asked).toBe(0)
  expect(unreachable.out).toMatch(/Score started/)
  await score(down, ['stop'])

  const installed = makeRig()
  await score(installed, ['service', 'install'], installEnv)
  await score(installed, ['stop'])
  const again = await scoreOnTerminal(installed, ['start'], [], installEnv)
  expect(again.asked).toBe(0)
  expect(again.out).toMatch(/Score started/)
}, 120_000)

test('prompt: no offer while a launcher-started Score is already running', async () => {
  const rig = makeRig()
  await score(rig, ['start'], installEnv)
  const result = await scoreOnTerminal(rig, ['start'], [], installEnv)
  expect(result.asked).toBe(0)
  expect(result.out).toMatch(/already running/)
  await score(rig, ['stop'])
}, 60_000)

test('run exports SCORE_RUN_AS=service only under systemd with the unit installed', async () => {
  const envOf = (rig: Rig) =>
    JSON.parse(readFileSync(join(rig.home, 'stub-env.json'), 'utf8')) as Record<string, string>
  // through the fake systemd (INVOCATION_ID set, unit installed)
  const rig = makeRig()
  await score(rig, ['service', 'install'], { ...installEnv, SCORE_RUN_AS: 'leak' })
  expect(envOf(rig).SCORE_RUN_AS).toBe('service')
  expect(readFileSync(join(rig.cfgDir, 'score.env'), 'utf8')).not.toMatch(
    /SCORE_RUN_AS|SERVICE_PROMPT/,
  )
  await score(rig, ['stop'])
  // a hand-run `run` (no INVOCATION_ID) with the unit installed is not the service
  const hand = spawn(join(rig.root, 'scripts/score'), ['run'], {
    env: { ...rig.env, SCORE_MODE: 'fake', SCORE_RUN_AS: 'service' },
    stdio: 'ignore',
  })
  spawned.push(hand)
  for (let i = 0; i < 100 && !existsSync(join(rig.home, 'pair-link')); i++)
    await new Promise((resolve) => setTimeout(resolve, 100))
  expect(envOf(rig).SCORE_RUN_AS).toBeUndefined()
  hand.kill('SIGTERM')
  // the launcher's own start never sets it
  const plain = makeRig()
  await score(plain, ['start'], installEnv)
  expect(envOf(plain).SCORE_RUN_AS).toBeUndefined()
  await score(plain, ['stop'])
}, 90_000)

test('a launcher for another home never drives the installed service (2026-10-20: tests restarted the live one)', async () => {
  const rig = makeRig()
  expect((await score(rig, ['service', 'install'], installEnv)).code).toBe(0)
  const servicePid = pidOf(rig)
  const before = calls(rig).length
  const other = mkdtempSync(join(tmpdir(), 'score-other-home-'))
  const otherEnv = { SCORE_HOME: other, ...installEnv }
  // start/stop/status for another home act as a plain launcher on that home: no systemctl call reaches the service.
  const started = await score(rig, ['start'], { ...otherEnv, SCORE_NO_SERVICE_PROMPT: '1' })
  expect(started.code).toBe(0)
  expect(started.out).not.toMatch(/systemctl/)
  expect((await score(rig, ['status'], otherEnv)).out).toMatch(/Score is running \(pid \d+\)/)
  expect((await score(rig, ['stop'], otherEnv)).code).toBe(0)
  expect(calls(rig).slice(before)).not.toMatch(/--user (start|stop|restart|reset-failed) score/)
  expect(alive(servicePid)).toBe(true)
  // Installing, uninstalling or reading the service from another home is refused instead of overwriting it.
  const install = await score(rig, ['service', 'install'], otherEnv)
  expect(install.code).not.toBe(0)
  expect(install.err).toMatch(/installed for .*score-home/)
  const uninstall = await score(rig, ['service', 'uninstall'], otherEnv)
  expect(uninstall.code).not.toBe(0)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(true)
}, 120_000)

test('no offer on a terminal start for another home while a service is installed for a different one', async () => {
  const rig = makeRig()
  expect((await score(rig, ['service', 'install'], installEnv)).code).toBe(0)
  const other = mkdtempSync(join(tmpdir(), 'score-other-home-'))
  const result = await scoreOnTerminal(rig, ['start'], [], { ...installEnv, SCORE_HOME: other })
  expect(result.asked).toBe(0)
  expect(result.out).toMatch(/Score started/)
  await score(rig, ['stop'], { SCORE_HOME: other })
}, 120_000)

test('a prompt answered after another home installed the service is refused, not an overwrite (cross-check)', async () => {
  const rig = makeRig()
  const homeB = mkdtempSync(join(tmpdir(), 'score-home-b-'))
  // B's first terminal start shows the question; while it waits, A installs the service; then B answers yes.
  const child = spawn(
    'script',
    ['-qec', [join(rig.root, 'scripts/score'), 'start'].join(' '), '/dev/null'],
    { env: { ...rig.env, ...installEnv, SCORE_HOME: homeB }, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  spawned.push(child)
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
  for (let i = 0; i < 100 && !out.includes(QUESTION); i++)
    await new Promise((resolve) => setTimeout(resolve, 100))
  expect(out).toContain(QUESTION)
  expect((await score(rig, ['service', 'install'], installEnv)).code).toBe(0)
  const unitBefore = readFileSync(join(rig.unitDir, 'score.service'), 'utf8')
  const envBefore = readFileSync(join(rig.cfgDir, 'score.env'), 'utf8')
  child.stdin.write('\n')
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)))
  expect(code).not.toBe(0)
  expect(out.replaceAll('\r', '')).toMatch(/installed for .*score-home/)
  expect(readFileSync(join(rig.unitDir, 'score.service'), 'utf8')).toBe(unitBefore)
  expect(readFileSync(join(rig.cfgDir, 'score.env'), 'utf8')).toBe(envBefore)
}, 120_000)
