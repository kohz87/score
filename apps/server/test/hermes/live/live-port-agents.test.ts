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
