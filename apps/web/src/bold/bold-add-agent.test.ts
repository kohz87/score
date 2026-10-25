import { AgentSummarySchema, type AgentSummary } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { addBlockReasons, availableStyle, colourChoices, saveRunsOn } from './bold-add-agent.ts'

const addAgentPalette = ['#6b8cff', '#2bb3c0', '#ff8a3d', '#8bd450'] as const

function agent(id: string, color: string, removed = false): AgentSummary {
  return AgentSummarySchema.parse({
    id,
    name: id,
    role: '',
    style: { color, shape: 'hexagon' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
    ...(removed
      ? {
          lifecycle: {
            state: 'removed',
            incarnationId: '11111111-1111-4111-8111-111111111111',
            operationId: null,
          },
        }
      : {}),
  })
}

afterEach(() => vi.unstubAllGlobals())

test('a full palette offers unused generated colours and never picks a taken one', () => {
  const agents = addAgentPalette.map((colour, index) => agent(`agent-${index}`, colour))
  const choices = colourChoices(agents)

  expect(choices.slice(0, 4).every((choice) => choice.takenBy !== null)).toBe(true)
  const free = choices.filter((choice) => choice.takenBy === null)
  expect(free.length).toBeGreaterThan(0)
  expect(new Set(choices.map((choice) => choice.colour)).size).toBe(choices.length)

  const style = availableStyle(agents)
  expect(agents.some((item) => item.style.color.toLowerCase() === style.color)).toBe(false)
  expect(choices.find((choice) => choice.colour === style.color)?.takenBy).toBeNull()
})

test('removed agents do not keep a colour', () => {
  const choices = colourChoices([agent('gone', addAgentPalette[0], true)])
  expect(choices[0]?.takenBy).toBeNull()
})

test('saveRunsOn returns the answer so the joined screen can state what separated', async () => {
  const answer = {
    backend: 'docker',
    raw: 'docker',
    separated: 'partly',
    docker: {
      image: null,
      network: true,
      mountsWorkspace: false,
      runsAsRoot: true,
      extraMounts: 0,
    },
    ssh: null,
    separatedTools: ['Terminal commands'],
    hostTools: ['MCP servers'],
    notes: ['Commands run as root inside the container.'],
    checked: { how: 'live', hermes: '0.21.5', at: '2026-10-24' },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(answer)),
  )

  await expect(saveRunsOn('builder', { backend: 'docker' })).resolves.toEqual(answer)
})

const local = { backend: 'local', sshHost: '', sshUser: '' }
test('keeps the server blockers and explains the bridge URL one', () => {
  const reasons = addBlockReasons(
    ['A pinned bridge installation URL has not been configured.'],
    {},
    false,
    local,
  )
  expect(reasons).toHaveLength(1)
  expect(reasons[0]).toContain('SCORE_BRIDGE_INSTALL_URL')
  expect(reasons[0]).toContain('SCORE_BRIDGE_INSTALL_REF')
})
test('names an unconfirmed clone and a missing SSH host and user', () => {
  expect(addBlockReasons([], { cloneFrom: 'builder' }, false, local)).toEqual([
    'Tick “I’ve checked what this agent inherits.”',
  ])
  expect(
    addBlockReasons([], {}, false, { backend: 'ssh', sshHost: ' ', sshUser: '' }),
  ).toHaveLength(2)
  expect(addBlockReasons([], { cloneFrom: 'builder' }, true, local)).toEqual([])
})

test('reusing a removed agent’s name needs its own tick (2.0.8)', () => {
  const local = { backend: 'local', sshHost: '', sshUser: '' }
  expect(
    addBlockReasons([], {}, false, local, { id: 'g3', needed: true, confirmed: false }),
  ).toEqual(['Tick “Use the name g3 again.”'])
  expect(
    addBlockReasons([], {}, false, local, { id: 'g3', needed: true, confirmed: true }),
  ).toEqual([])
})
