import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'
import { agentCases } from './schemas-cases-agents.ts'

describe.each(agentCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

test('AgentDetail extends the summary and accepts an unreadable model', () => {
  const detail = {
    ...f.agent,
    tagline: 'Builds what lead plans.',
    personality: { excerpt: 'Careful builder.', source: 'SOUL.md' },
    reportsTo: 'lead',
    worksIn: null,
    rulesFile: 'AGENTS.md',
    model: null,
    skills: [{ name: 'git', enabled: true }],
    memory: [],
    tools: [],
    helpersMax: null,
    routines: [],
    channels: [],
    permissions: [],
  }
  expect(contract.AgentDetailSchema.parse(detail)).toEqual(detail)
  expect(contract.AgentDetailSchema.safeParse({ ...detail, rulesFile: 'SOUL.md' }).success).toBe(
    false,
  )
})

test('HTTP snapshots accept asOfSeq 0 (fresh server) and reject negatives', () => {
  expect(contract.AgentsSnapshotSchema.parse({ asOfSeq: 0, items: [f.agent] }).asOfSeq).toBe(0)
  expect(contract.AgentsSnapshotSchema.safeParse({ asOfSeq: -1, items: [] }).success).toBe(false)
  expect(
    contract.ErrorEnvelopeSchema.parse({ error: { code: 'not_found', message: 'Unknown room' } }),
  ).toMatchObject({ error: { code: 'not_found' } })
})

test('a summary message part is text only and a room carries its setting', () => {
  const part = { kind: 'summary', coversUntil: 'm1', text: 'Plan B', stale: true }
  expect(contract.MessagePartSchema.parse(part)).toEqual(part)
  expect(contract.MessagePartSchema.safeParse({ ...part, coversUntil: '' }).success).toBe(false)
  expect(contract.MessagePartSchema.safeParse({ ...part, text: 'x'.repeat(16385) }).success).toBe(
    false,
  )
  expect(
    contract.MessageUpdatedSchema.parse({ roomId: 'r', messageId: 'm', parts: [part] }).parts,
  ).toHaveLength(1)
})

test('PLAN 11.11: an old style that still carries look or pack parses and the fields are dropped', () => {
  const old = contract.AgentStyleSchema.parse({
    color: '#6B4EFF',
    shape: 'circle-dot',
    look: 'cut',
    pack: { rev: 'a1', activities: ['idle'], name: null, credits: null, floor: 0 },
  })
  expect(old).toEqual({ color: '#6B4EFF', shape: 'circle-dot' })
  const patch = contract.AgentStylePatchSchema.parse({ look: 'ring', pack: { rev: 'x' } })
  expect(patch).toEqual({})
})
