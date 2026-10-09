import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cachingRunner } from '../../../src/hermes/live/config-cache.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'

let home: string
const inner = vi.fn<HermesRunner>()
let runner: HermesRunner
const read = { timeoutMs: 1000, captureRead: true }
const get = (key = 'model', profile = 'builder') =>
  runner(['-p', profile, 'config', 'get', '--json', key], read)
const touch = (profile = 'builder') => {
  const file = join(home, 'profiles', profile, 'config.yaml')
  fs.writeFileSync(file, `x: ${Math.random()}\n`)
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000 * Math.random() + 1000))
}
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-cache-'))
  for (const p of ['builder', 'lead']) {
    fs.mkdirSync(join(home, 'profiles', p), { recursive: true })
    fs.writeFileSync(join(home, 'profiles', p, 'config.yaml'), 'a: 1\n')
  }
  inner.mockReset().mockResolvedValue({ exitCode: 0, stdout: '{"default":"m"}' })
  runner = cachingRunner(inner, home)
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

test('an unchanged config.yaml answers from memory, per profile and key', async () => {
  await get()
  await get()
  await get()
  expect(inner).toHaveBeenCalledTimes(1)
  await get('providers')
  await get('model', 'lead')
  expect(inner).toHaveBeenCalledTimes(3)
})

test('an outside edit changes the signature and re-reads', async () => {
  await get()
  touch()
  await get()
  expect(inner).toHaveBeenCalledTimes(2)
})

test('a Score write through the runner drops that profile only', async () => {
  await get()
  await get('model', 'lead')
  await runner(['-p', 'builder', 'config', 'set', 'model.default', 'x'], { timeoutMs: 1000 })
  await get()
  await get('model', 'lead')
  expect(inner.mock.calls.filter(([a]) => a.includes('get'))).toHaveLength(3)
})

test('failed reads are not stored and retry on the next call', async () => {
  inner.mockResolvedValueOnce({ exitCode: -1 })
  expect((await get()).exitCode).toBe(-1)
  expect((await get()).exitCode).toBe(0)
  await get()
  expect(inner).toHaveBeenCalledTimes(2)
})

test('"key never set" (exit 1) is cached as an answer', async () => {
  inner.mockResolvedValue({ exitCode: 1 })
  await get('skills.disabled')
  await get('skills.disabled')
  expect(inner).toHaveBeenCalledTimes(1)
})

test('concurrent identical reads share one CLI call', async () => {
  await Promise.all([get(), get(), get()])
  expect(inner).toHaveBeenCalledTimes(1)
})

test('plugin and tool lists are cached the same way; other commands pass through', async () => {
  const plugins = () => runner(['-p', 'builder', 'plugins', 'list', '--json'], read)
  await plugins()
  await plugins()
  expect(inner).toHaveBeenCalledTimes(1)
  await runner(['-p', 'builder', 'plugins', 'enable', 'p'], { timeoutMs: 1000 })
  await plugins()
  expect(inner).toHaveBeenCalledTimes(3)
  await runner(['kanban', 'list'], { timeoutMs: 1000 })
  await runner(['kanban', 'list'], { timeoutMs: 1000 })
  expect(inner).toHaveBeenCalledTimes(5)
})
