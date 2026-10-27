import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { LivePort } from '../../../src/hermes/live/live-port.ts'

// 3.7.9 (decision 140): the gateway restart Hermes runs for Reload MCP.

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function port(exitCode: number) {
  const hermesHome = fs.mkdtempSync(join(os.tmpdir(), 'score-restart-'))
  const scoreHome = fs.mkdtempSync(join(os.tmpdir(), 'score-home-'))
  homes.push(hermesHome, scoreHome)
  fs.writeFileSync(join(hermesHome, 'config.yaml'), 'model: x\n')
  fs.mkdirSync(join(hermesHome, 'profiles', 'builder'), { recursive: true })
  const calls: { args: string[]; stdout: boolean }[] = []
  const live = new LivePort({
    scoreHome,
    hermesHome,
    readCliVersion: async () => null,
    runner: async (args, options) => {
      calls.push({
        args,
        stdout: Boolean(
          options.captureRead ||
          options.captureModel ||
          options.captureSettings ||
          options.captureTaskCreate,
        ),
      })
      return { exitCode }
    },
  })
  return { live, calls }
}

test('a named profile restarts alone, without -y, and Hermes’ output is never read', async () => {
  const { live, calls } = port(0)
  await live.restartGateway('builder')
  expect(calls).toEqual([{ args: ['-p', 'builder', 'gateway', 'restart'], stdout: false }])
})

test('a refusal is a 502; default names live sessions; an unknown agent is a 404 and runs nothing', async () => {
  const { live, calls } = port(1)
  await expect(live.restartGateway('builder')).rejects.toMatchObject({
    status: 502,
    code: 'gateway_restart_failed',
  })
  await expect(live.restartGateway('default')).rejects.toThrow(
    /refuses while any agent’s session is live/,
  )
  await expect(live.restartGateway('nobody')).rejects.toMatchObject({ status: 404 })
  expect(calls.map((call) => call.args[1])).toEqual(['builder', 'default'])
})
