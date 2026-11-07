import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'

const fixture = fileURLToPath(new URL('../../fixtures/hermes/', import.meta.url))
export const toolsText = fs.readFileSync(join(fixture, 'tools-list.txt'), 'utf8')
let tools: Map<string, boolean>

export type AgentTabsState = {
  home: string
  disabled: string[] | undefined
  exit: Record<string, number>
  runner: Mock<HermesRunner>
  reader: ProfilesReader
  tabs: LiveAgentTabs
}

let active: AgentTabsState

// Stands in for the `hermes` binary: answers the allowlisted reads and applies the writes it is sent.
export function hermes(args: string[]): { exitCode: number; stdout?: string } {
  const [, , ...rest] = args[0] === '-p' ? args : ['-p', '', ...args]
  const verb = rest.join(' ')
  if (active.exit[rest[0] + ' ' + rest[1]] !== undefined)
    return { exitCode: active.exit[rest[0] + ' ' + rest[1]]! }
  if (verb === 'config get --json skills.disabled')
    return active.disabled
      ? { exitCode: 0, stdout: JSON.stringify(active.disabled) }
      : { exitCode: 1 }
  if (verb === 'config get --json command_allowlist') return { exitCode: 0, stdout: '[]' }
  if (verb === 'config get --json approvals') return { exitCode: 0, stdout: '{}' }
  if (verb === 'config get --json delegation.max_concurrent_children')
    return { exitCode: 0, stdout: '4' }
  if (verb === 'config get --json model')
    return { exitCode: 0, stdout: JSON.stringify({ default: 'fixture-model', provider: 'p' }) }
  if (rest[0] === 'config' && rest[1] === 'set' && rest[2] === 'skills.disabled') {
    active.disabled = JSON.parse(rest[3]!)
    return { exitCode: 0 }
  }
  if (rest[0] === 'tools' && rest[1] === 'list' && rest.at(-1) === 'api_server')
    return {
      exitCode: 0,
      stdout: toolsText
        .split('\n')
        .map((line) => {
          const id = /^\s+[✓✗] \w+\s+(\S+)/u.exec(line)?.[1]
          return id && tools.has(id)
            ? line.replace(/[✓✗] (enabled|disabled)/u, tools.get(id) ? '✓ enabled' : '✗ disabled')
            : line
        })
        .join('\n'),
    }
  if (rest[0] === 'tools' && (rest[1] === 'enable' || rest[1] === 'disable')) {
    // Only the api_server platform decides what a Score-started run can use; the cli platform is a separate list.
    if (rest[3] === 'api_server') tools.set(rest[5]!, rest[1] === 'enable')
    return { exitCode: 0 }
  }
  if (rest[0] === 'skills' && rest[1] === 'search')
    return {
      exitCode: 0,
      stdout: JSON.stringify([
        {
          name: 'changelog-writer',
          identifier: 'example/skills/changelog-writer',
          source: 'official',
          trust_level: 'builtin',
          description: 'Drafts a changelog. token=private-value',
          extra: 1,
        },
      ]),
    }
  return { exitCode: 0 }
}

export function installAgentTabsHooks(state: AgentTabsState) {
  active = state
  beforeEach(() => {
    state.home = fs.mkdtempSync(join(tmpdir(), 'score-tabs-'))
    fs.cpSync(join(fixture, 'profiles', 'default'), state.home, { recursive: true })
    fs.cpSync(join(fixture, 'profiles', 'builder'), join(state.home, 'profiles', 'builder'), {
      recursive: true,
    })
    state.disabled = undefined
    tools = new Map()
    state.exit = {}
    state.runner = vi.fn<HermesRunner>().mockImplementation(async (args) => hermes(args))
    state.reader = new ProfilesReader(state.home, state.runner)
    state.tabs = new LiveAgentTabs(
      state.home,
      (profile) => state.reader.profileHome(profile),
      (profile) => state.reader.invalidate(profile),
      state.runner,
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(state.home, { recursive: true, force: true })
  })
}

export const writes = () =>
  active.runner.mock.calls
    .map(([args]) => args)
    .filter((args) => !['get', 'list', 'search'].some((verb) => args.includes(verb)))
