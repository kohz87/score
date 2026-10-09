import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HttpError } from '../../../src/errors.ts'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import { captureReadShape, type HermesRunner } from '../../../src/hermes/live/cli.ts'

let home: string
const values = new Map<string, string>()
const runner = vi.fn<HermesRunner>()
let tabs: LiveAgentTabs
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-wscfg-'))
  fs.mkdirSync(join(home, 'profiles', 'builder'), { recursive: true })
  values.clear()
  runner.mockReset().mockImplementation(async (args) => {
    const verb = args.slice(2).join(' ')
    const get = /^config get --json (terminal\.(?:cwd|backend))$/.exec(verb)
    if (get) {
      const value = values.get(get[1]!)
      return value === undefined ? { exitCode: 1 } : { exitCode: 0, stdout: JSON.stringify(value) }
    }
    if (args[2] === 'config' && args[3] === 'set') {
      values.set(args[4]!, args[5]!)
      return { exitCode: 0 }
    }
    return { exitCode: 0 }
  })
  tabs = new LiveAgentTabs(
    home,
    (profile) => join(home, 'profiles', profile),
    () => undefined,
    runner,
  )
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

test('terminal.cwd and terminal.backend are allowlisted config reads', () => {
  for (const key of ['terminal.cwd', 'terminal.backend'])
    expect(captureReadShape(['-p', 'builder', 'config', 'get', '--json', key])).toBe(true)
  expect(captureReadShape(['-p', 'builder', 'config', 'get', '--json', 'terminal.ssh_key'])).toBe(
    false,
  )
})

test('reads cwd and backend; a never-set key is null', async () => {
  expect(await tabs.readWorkspaceConfig('builder')).toEqual({ cwd: null, backend: null })
  values.set('terminal.cwd', '/srv/project')
  values.set('terminal.backend', 'local')
  expect(await tabs.readWorkspaceConfig('builder')).toEqual({
    cwd: '/srv/project',
    backend: 'local',
  })
})

test('an unreadable config is a 502, not an empty workspace', async () => {
  runner.mockResolvedValue({ exitCode: -1 })
  await expect(tabs.readWorkspaceConfig('builder')).rejects.toMatchObject({ status: 502 })
})

test('setting the folder runs `hermes -p <profile> config set terminal.cwd <path>` with an argv array', async () => {
  await tabs.setWorkspaceCwd('builder', '/srv/my project; rm -rf /')
  const call = runner.mock.calls.find(([args]) => args.includes('set'))!
  expect(call[0]).toEqual([
    '-p',
    'builder',
    'config',
    'set',
    'terminal.cwd',
    '/srv/my project; rm -rf /',
  ])
  expect(values.get('terminal.cwd')).toBe('/srv/my project; rm -rf /')
  runner.mockResolvedValue({ exitCode: 1 })
  await expect(tabs.setWorkspaceCwd('builder', '/x')).rejects.toBeInstanceOf(HttpError)
})
