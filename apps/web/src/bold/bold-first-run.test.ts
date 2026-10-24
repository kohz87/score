import { WorkflowDefinitionSchema, type SystemStatus } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import {
  FIRST_RUN_DONE_KEY,
  finishFirstRun,
  firstRunDone,
  hermesStatusCopy,
  shouldShowFirstRun,
  starterDefinition,
  starterMissing,
  starterRecipes,
} from './bold-first-run.ts'

const members = ['lead', 'builder', 'reviewer', 'designer']

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

test('every starter recipe is a valid workflow that uses the team ids', () => {
  for (const recipe of starterRecipes) {
    const definition = starterDefinition(recipe, members)
    expect(definition, recipe.name).not.toBeNull()
    expect(WorkflowDefinitionSchema.parse(definition).name).toBe(recipe.name)
    const agentIds = definition!.nodes.flatMap((node) =>
      node.kind === 'agent' ? [node.agentId] : [],
    )
    for (const role of recipe.agents) expect(agentIds, recipe.name).toContain(role)
  }
  expect(starterRecipes.map((recipe) => recipe.name)).toEqual([
    'Build, then review',
    'Write, review, design',
    'Research report',
  ])
})

test('a starter recipe stays unavailable, and names the missing agents, when the team lacks one', () => {
  const buildAndReview = starterRecipes[0]!
  expect(starterDefinition(buildAndReview, ['lead', 'builder'])).toBeNull()
  expect(starterMissing(buildAndReview, ['lead', 'builder'])).toEqual(['reviewer'])
})
