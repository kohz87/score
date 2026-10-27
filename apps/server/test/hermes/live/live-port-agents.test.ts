import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LivePort } from '../../../src/hermes/live/live-port.ts'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function coldPort() {
  const hermesHome = fs.mkdtempSync(join(os.tmpdir(), 'score-agents-'))
  const scoreHome = fs.mkdtempSync(join(os.tmpdir(), 'score-home-'))
  homes.push(hermesHome, scoreHome)
  fs.writeFileSync(join(hermesHome, 'config.yaml'), 'model: x\n')
  fs.mkdirSync(join(hermesHome, 'profiles', 'builder'), { recursive: true })
  fs.writeFileSync(join(hermesHome, 'profiles', 'builder', 'config.yaml'), 'model: x\n')
  const counter = { calls: 0 }
  const live = new LivePort({
    firstStatusWaitMs: 0,
    scoreHome,
    hermesHome,
    readCliVersion: async () => null,
    runner: async () => {
      counter.calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { exitCode: 0, stdout: '"fixture-model"' }
    },
  })
  return { live, counter }
}

test('concurrent agent reads share one set of Hermes processes, and each caller gets its own copy', async () => {
  const solo = coldPort()
  await solo.live.listAgentDetails()
  expect(solo.counter.calls).toBeGreaterThan(0)

  const shared = coldPort()
  const [first, second, third] = await Promise.all([
    shared.live.listAgentDetails(),
    shared.live.listAgents(),
    shared.live.listAgentDetails(),
  ])
  // Agents, Rooms and Now loading together cost one cold read, not three.
  expect(shared.counter.calls).toBe(solo.counter.calls)
  expect(first.map((agent) => agent.id).sort()).toEqual(['builder', 'default'])
  expect(second.map((agent) => agent.id).sort()).toEqual(['builder', 'default'])
  expect(third).not.toBe(first)
  expect(third[0]).not.toBe(first[0])
})

test('an agent list asked for before the first gateway status waits for it, so a served idle agent is not "offline" (3.9.1)', async () => {
  const hermesHome = fs.mkdtempSync(join(os.tmpdir(), 'score-agents-'))
  const scoreHome = fs.mkdtempSync(join(os.tmpdir(), 'score-home-'))
  homes.push(hermesHome, scoreHome)
  fs.writeFileSync(join(hermesHome, 'config.yaml'), 'model: x\n')
  fs.mkdirSync(join(hermesHome, 'profiles', 'builder'), { recursive: true })
  fs.writeFileSync(join(hermesHome, 'profiles', 'builder', 'config.yaml'), 'model: x\n')
  fs.writeFileSync(
    join(hermesHome, 'gateway_state.json'),
    JSON.stringify({ served_profiles: ['default', 'builder'] }),
  )
  const live = new LivePort({
    firstStatusWaitMs: 10_000,
    scoreHome,
    hermesHome,
    readCliVersion: async () => null,
    runner: async () => ({ exitCode: 0, stdout: '"fixture-model"' }),
  })
  // Score answers HTTP before the port has started: the read is asked for first, the status arrives after.
  const asked = live.listAgentDetails()
  await (live as unknown as { refreshStatus(): Promise<void> }).refreshStatus()
  const builder = (await asked).find((agent) => agent.id === 'builder')
  expect(builder?.status).toBe('idle')
  expect(builder?.served).toBe(true)
})
