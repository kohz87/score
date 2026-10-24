import { WorkflowDefinitionSchema, type SystemStatus } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import {
  FIRST_RUN_DONE_KEY,
  finishFirstRun,
  firstRunDone,
  firstRunView,
  hermesStatusCopy,
  shouldShowFirstRun,
  starterPlan,
  starterRecipes,
} from './bold-first-run.ts'

const agents = [
  { id: 'captain', role: 'Leads the team' },
  { id: 'maker', role: 'Builds features' },
  { id: 'checker', role: 'Reviews changes' },
  { id: 'artist', role: 'Designs interfaces' },
]
const members = agents.map((agent) => agent.id)

const system = (overrides: Partial<SystemStatus> = {}): SystemStatus => ({
  mode: 'fake',
  hermes: {
    version: '0.15.2',
    reachable: true,
    apiServer: true,
    capabilities: [],
    servedProfiles: members,
  },
  bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
  compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
  agentIsolation: 'same_user',
  degraded: [],
  ...overrides,
})

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

test('first run waits for a room with no lead, unless the link forces it or this device finished it', () => {
  expect(shouldShowFirstRun(false, false, undefined)).toBe(false)
  expect(shouldShowFirstRun(false, false, { leadAgentId: null })).toBe(true)
  expect(shouldShowFirstRun(false, false, { leadAgentId: 'lead' })).toBe(false)
  expect(shouldShowFirstRun(false, true, { leadAgentId: null })).toBe(false)
  expect(shouldShowFirstRun(true, true, { leadAgentId: 'lead' })).toBe(true)

  expect(firstRunView(false, false, undefined, true)).toBe('loading')
  expect(firstRunView(false, false, { leadAgentId: null }, false)).toBe('first-run')
  expect(firstRunView(false, false, { leadAgentId: 'lead' }, false)).toBe('room')
  expect(firstRunView(true, true, { leadAgentId: 'lead' }, true)).toBe('first-run')
})

test('the per-device flag is read and written, and a browser that refuses storage does not break', () => {
  expect(firstRunDone()).toBe(false)
  finishFirstRun()
  expect(window.localStorage.getItem(FIRST_RUN_DONE_KEY)).toBe('1')
  expect(firstRunDone()).toBe(true)

  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(firstRunDone()).toBe(false)
  expect(() => finishFirstRun()).not.toThrow()
})

test('Hermes is never called found when it cannot be reached or reports a problem', () => {
  expect(hermesStatusCopy(undefined, false).title).toBe('Checking Hermes…')
  expect(hermesStatusCopy(undefined, true).title).toBe('Couldn’t check Hermes')

  const found = hermesStatusCopy(system(), false)
  expect(found.title).toBe('Hermes found')
  expect(found.detail).toContain('Version 0.15.2, gateway running')
  expect(found.detail).toContain('Bridge waiting for a producer')
  expect(found.ok).toBe(true)

  const missing = hermesStatusCopy(
    system({
      hermes: {
        version: null,
        reachable: false,
        apiServer: false,
        capabilities: [],
        servedProfiles: [],
      },
    }),
    false,
  )
  expect(missing.title).toBe('Hermes not found')
  expect(missing.trouble).toContain('Score can’t reach Hermes on this machine.')
  expect(missing.trouble).toContain('The Hermes gateway is not running.')
  expect(missing.ok).toBe(false)

  const degraded = hermesStatusCopy(system({ degraded: ['The bridge is out of date.'] }), false)
  expect(degraded.title).toBe('Hermes found, but it needs attention')
  expect(degraded.trouble).toBe('The bridge is out of date.')
  expect(degraded.ok).toBe(false)
})

test('every starter recipe maps roles to the team ids, not to fixed agent names', () => {
  for (const recipe of starterRecipes) {
    const plan = starterPlan(recipe, { members, agents, leadAgentId: 'captain' })
    expect(plan.unmapped, recipe.name).toEqual([])
    expect(plan.unmappedSteps, recipe.name).toEqual([])
    expect(WorkflowDefinitionSchema.parse(plan.definition).name).toBe(recipe.name)
    const agentIds = plan.definition.nodes.flatMap((node) =>
      node.kind === 'agent' ? [node.agentId] : [],
    )
    expect(agentIds, recipe.name).not.toContain('')
    if (recipe.roles.includes('lead')) expect(agentIds).toContain('captain')
    if (recipe.roles.includes('builder')) expect(agentIds).toContain('maker')
    if (recipe.roles.includes('reviewer')) expect(agentIds).toContain('checker')
    if (recipe.roles.includes('designer')) expect(agentIds).toContain('artist')
  }
  expect(starterRecipes.map((recipe) => recipe.name)).toEqual([
    'Build, then review',
    'Write, review, design',
    'Research report',
  ])
})

test('a recipe leaves unmatched steps empty and names the steps the person must fill', () => {
  const buildAndReview = starterRecipes[0]!
  const plan = starterPlan(buildAndReview, {
    members: ['captain'],
    agents: [{ id: 'captain', role: 'Coordinates the work' }],
    leadAgentId: 'captain',
  })
  expect(plan.unmapped).toEqual(['Build it', 'Review it'])
  expect(plan.unmappedSteps).toEqual(['build it', 'review it'])
  expect(
    plan.definition.nodes.flatMap((node) =>
      node.kind === 'agent' && node.agentId === '' ? [node.label] : [],
    ),
  ).toEqual(['Build it', 'Review it'])

  const research = starterPlan(starterRecipes[2]!, {
    members: ['captain'],
    agents: [{ id: 'captain', role: 'Coordinates the work' }],
    leadAgentId: 'captain',
  })
  expect(research.unmapped).toEqual([])
  expect(research.definition.nodes.find((node) => node.kind === 'agent')).toMatchObject({
    agentId: 'captain',
  })
})
