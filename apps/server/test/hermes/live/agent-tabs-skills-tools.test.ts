import fs from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseToolList } from '../../../src/hermes/live/agent-config.ts'
import {
  installAgentTabsHooks,
  toolsText,
  type AgentTabsState,
  writes,
} from './agent-tabs-helpers.ts'

let home: AgentTabsState['home']
let disabled: AgentTabsState['disabled']
let exit: AgentTabsState['exit']
let runner: AgentTabsState['runner']
let reader: AgentTabsState['reader']
let tabs: AgentTabsState['tabs']
const testState: AgentTabsState = {
  get home() {
    return home
  },
  set home(value) {
    home = value
  },
  get disabled() {
    return disabled
  },
  set disabled(value) {
    disabled = value
  },
  get exit() {
    return exit
  },
  set exit(value) {
    exit = value
  },
  get runner() {
    return runner
  },
  set runner(value) {
    runner = value
  },
  get reader() {
    return reader
  },
  set reader(value) {
    reader = value
  },
  get tabs() {
    return tabs
  },
  set tabs(value) {
    tabs = value
  },
}
installAgentTabsHooks(testState)

test('tools list parses toolsets and MCP servers from plain output', () => {
  expect(parseToolList(toolsText)).toEqual([
    { id: 'web', label: 'Web Search & Scraping', kind: 'builtin', enabled: true },
    { id: 'terminal', label: 'Terminal & Processes', kind: 'builtin', enabled: true },
    { id: 'video', label: 'Video Analysis', kind: 'builtin', enabled: false },
    { id: 'a2a', label: 'A2A', kind: 'builtin', enabled: false },
    { id: 'tracker', label: 'tracker', kind: 'mcp', enabled: true },
    { id: 'docs', label: 'docs', kind: 'mcp', enabled: false },
  ])
  expect(parseToolList('garbage\nno sections')).toEqual([])
})

test('skill toggles rewrite skills.disabled through config set and keep other entries', async () => {
  disabled = ['other']
  expect(await tabs.listSkills('builder')).toEqual([{ name: 'implementation', enabled: true }])
  await tabs.setSkillEnabled('builder', 'implementation', false)
  expect(writes()).toEqual([
    ['-p', 'builder', 'config', 'set', 'skills.disabled', '["implementation","other"]'],
  ])
  runner.mockClear()
  await tabs.setSkillEnabled('builder', 'implementation', false)
  expect(writes()).toEqual([])
  await tabs.setSkillEnabled('builder', 'implementation', true)
  expect(writes()).toEqual([['-p', 'builder', 'config', 'set', 'skills.disabled', '["other"]']])
  await expect(tabs.setSkillEnabled('builder', 'missing', true)).rejects.toMatchObject({
    status: 404,
  })
})

test('install runs skills install with --yes and a literal identifier', async () => {
  await tabs.installSkill('builder', { name: 'example/skills/changelog-writer' })
  expect(writes()).toEqual([
    ['-p', 'builder', 'skills', 'install', '--yes', '--', 'example/skills/changelog-writer'],
  ])
  expect(runner.mock.calls[0]![1].timeoutMs).toBe(120000)
  for (const name of ['-x', 'a b', 'a;b', '']) {
    await expect(tabs.installSkill('builder', { name })).rejects.toThrow()
  }
  exit['skills install'] = 1
  await expect(tabs.installSkill('builder', { name: 'a/b' })).rejects.toMatchObject({ status: 409 })
})

test('hub search validates, redacts and bounds the result', async () => {
  expect(await tabs.searchHub('   ')).toEqual([])
  expect(runner).not.toHaveBeenCalled()
  expect(await tabs.searchHub('changelog')).toEqual([
    {
      name: 'changelog-writer',
      identifier: 'example/skills/changelog-writer',
      source: 'official',
      trust: 'builtin',
      description: 'Drafts a changelog. token=[redacted]',
    },
  ])
  expect(runner).toHaveBeenCalledWith(
    ['skills', 'search', '--json', '--limit', '20', '--', 'changelog'],
    { timeoutMs: 30000, hermesHome: home, captureRead: true },
  )
  runner.mockResolvedValue({ exitCode: 0, stdout: 'not json' })
  await expect(tabs.searchHub('x')).rejects.toMatchObject({ status: 502 })
  runner.mockResolvedValue({ exitCode: 1 })
  await expect(tabs.searchHub('x')).rejects.toMatchObject({ status: 502 })
})

test('tool toggles use tools enable/disable on the toolset id and verify the result', async () => {
  const on = await tabs.setToolEnabled('builder', 'video', true)
  expect(on).toMatchObject({ id: 'video', enabled: true })
  // Score's runs use the api_server platform; Kanban workers use cli. Both are switched, the run platform is verified.
  expect(writes()).toEqual([
    ['-p', 'builder', 'tools', 'enable', '--platform', 'cli', '--', 'video'],
    ['-p', 'builder', 'tools', 'enable', '--platform', 'api_server', '--', 'video'],
  ])
  runner.mockClear()
  await tabs.setToolEnabled('builder', 'video', true)
  expect(writes()).toEqual([])
  await tabs.setToolEnabled('builder', 'web', false)
  expect(writes().map((args) => args.slice(2, 6))).toEqual([
    ['tools', 'disable', '--platform', 'cli'],
    ['tools', 'disable', '--platform', 'api_server'],
  ])
  await expect(tabs.setToolEnabled('builder', 'nope', true)).rejects.toMatchObject({ status: 404 })
  await expect(tabs.setToolEnabled('builder', 'tracker', false)).rejects.toMatchObject({
    status: 501,
  })
  await expect(tabs.setToolEnabled('builder', '--all', true)).rejects.toThrow()
})

test('a skill toggle never rewrites skills.disabled when the current list could not be read', async () => {
  disabled = ['private-skill']
  exit['config get'] = -1
  await expect(tabs.setSkillEnabled('builder', 'implementation', false)).rejects.toMatchObject({
    status: 502,
  })
  expect(writes()).toEqual([])
  expect(disabled).toEqual(['private-skill'])
  // A key Hermes says is not set (exit 1) is an empty list, not a failure.
  exit['config get'] = 1
  await tabs.setSkillEnabled('builder', 'implementation', false)
  expect(disabled).toEqual(['implementation'])
})

test('skills are listed and disabled by their declared name, not their directory name', async () => {
  const dir = join(home, 'profiles', 'builder', 'skills', 'team', 'folder')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: "release-checklist"\ndescription: x\n---\nBody\n',
  )
  const listed = (await tabs.listSkills('builder')).map((skill) => skill.name)
  expect(listed).toContain('release-checklist')
  expect(listed).not.toContain('folder')
  await tabs.setSkillEnabled('builder', 'release-checklist', false)
  expect(disabled).toEqual(['release-checklist'])
  await expect(tabs.setSkillEnabled('builder', 'folder', false)).rejects.toMatchObject({
    status: 404,
  })
})
