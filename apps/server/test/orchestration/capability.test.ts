import { ORC_CAPABILITY_PLACEHOLDER, type OrchReceipt } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { hashCapability } from '../../src/domain/orchestration/capability.ts'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { attemptOf, harness, type Harness } from './harness.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})
const status = (id: string) => h.orch.summary(id).status

/** Every table's content as one string: what a stolen database file would show. */
function dump(): string {
  const tables = h.rows<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  return tables.map(({ name }) => JSON.stringify(h.rows(`SELECT * FROM ${name}`))).join('\n')
}

test('the capability is never stored: placeholder in the durable input, a hash in the table, nowhere else', async () => {
  const seen: string[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          seen.push(t.capability)
          await t.call('orch.note', { text: 'hello' })
          await t.call('orch.assign', { agent: 'builder', instruction: 'work' })
          // A lead that echoes its capability into its reply: the stored reply must be redacted.
          return `my capability is ${t.capability}`
        },
        2: async (t) => {
          seen.push(t.capability)
          await t.call('orch.finish', { outcome: 'success', summary: 'x' })
        },
      }),
    },
  })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'succeeded' || status(id) === 'paused')
  expect(seen).toHaveLength(2)
  expect(seen[0]).not.toBe(seen[1])
  const everything = dump()
  for (const capability of seen) {
    expect(capability).toMatch(/^orc_[A-Za-z0-9_-]{43}$/)
    expect(everything).not.toContain(capability)
    expect(
      h.rows('SELECT 1 FROM orc_capabilities WHERE hash = ?', hashCapability(capability)),
    ).toHaveLength(1)
  }
  const input = h.rows<{ input: string }>(
    "SELECT input FROM orc_attempts WHERE kind = 'lead' ORDER BY n",
  )[0]!.input
  expect(input).toContain(ORC_CAPABILITY_PLACEHOLDER)
  expect(input).not.toMatch(/orc_[A-Za-z0-9_-]{8,}/)
  // The streamed reply was redacted on the way into the room.
  const texts = h
    .rows<{ parts: string }>("SELECT parts FROM messages WHERE author_kind = 'agent'")
    .map((row) => row.parts)
    .join('\n')
  expect(texts).toContain('my capability is [redacted]')
})

test('capabilities are bound to their agent: another agent presenting it is refused, a stranger capability too', async () => {
  let capability = ''
  const results: unknown[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          capability = t.capability
          results.push(
            await h.orch.handleTool('builder', 'orch.note', {
              capability: t.capability,
              commandId: 'x1',
              text: 'spoof',
            }),
          )
          results.push(
            await h.orch.handleTool('lead', 'orch.note', {
              capability: `orc_${'A'.repeat(43)}`,
              commandId: 'x2',
              text: 'guess',
            }),
          )
          results.push(
            await h.orch.handleTool('lead', 'orch.note', {
              capability: 'orc_short',
              commandId: 'x3',
              text: 'malformed',
            }),
          )
          return 'ok'
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => status(id) === 'paused')
  expect(results).toEqual([
    { kind: 'unauthorized', message: 'this capability belongs to another agent' },
    { kind: 'unauthorized', message: 'unknown capability' },
    {
      kind: 'receipt',
      receipt: expect.objectContaining({ status: 'refused', code: 'bad_arguments' }),
    },
  ])
  expect(capability).not.toBe('')
  expect(h.rows("SELECT 1 FROM messages WHERE id LIKE 'orc-note:%'")).toHaveLength(0)
})

test('a capability expires with its attempt: a delayed call with an earlier turn capability is refused', async () => {
  const capabilities: string[] = []
  let late: unknown
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          capabilities.push(t.capability)
          await t.call('orch.assign', { agent: 'builder', instruction: 'work' })
        },
        2: async (t) => {
          capabilities.push(t.capability)
          // A delayed duplicate of turn 1's call arrives during turn 2.
          late = await h.orch.handleTool('lead', 'orch.assign', {
            capability: capabilities[0]!,
            commandId: 'late',
            agent: 'builder',
            instruction: 'sneak',
          })
          await t.call('orch.finish', { outcome: 'success', summary: 'x' })
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  expect(late).toEqual({ kind: 'unauthorized', message: expect.stringContaining('expired') })
  expect(h.orch.snapshot(id).orchestration.stepsList).toHaveLength(1)
  // After the run, every capability of the run is expired in the table.
  expect(h.rows('SELECT 1 FROM orc_capabilities WHERE expired_at IS NULL')).toHaveLength(0)
})

test('a lead whose agent was replaced since the capability was issued is refused', async () => {
  let result: unknown
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          h.db.sqlite
            .prepare(
              "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES ('lead', ?, 'ready')",
            )
            .run('11111111-1111-4111-8111-111111111111')
          result = await h.orch.handleTool('lead', 'orch.note', {
            capability: t.capability,
            commandId: 'n',
            text: 'x',
          })
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => status(id) === 'paused')
  expect(result).toEqual({
    kind: 'unauthorized',
    message: 'the lead agent changed since this capability was issued',
  })
})

test('calls outside any turn are refused: before a turn, after Stop', async () => {
  let capability = ''
  h = await harness({
    lead: {
      script: async (t) => {
        capability = t.capability
        await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
      },
    },
  })
  expect(
    await h.orch.handleTool('lead', 'orch.note', {
      capability: `orc_${'B'.repeat(43)}`,
      commandId: 'a',
      text: 'x',
    }),
  ).toMatchObject({ kind: 'unauthorized' })
  const id = await h.create()
  await h.until(() => h.orch.snapshot(id).orchestration.stepsList.length === 1)
  await h.orch.stop(id)
  const after = await h.orch.handleTool('lead', 'orch.note', {
    capability,
    commandId: 'b',
    text: 'late',
  })
  expect(after.kind).toBe('unauthorized')
})

test('step inputs are scanned for the capability prefix: a match blocks admission', async () => {
  h = await harness({ lead: { script: byTurn({ 1: async () => 'no tools' }) } })
  const id = await h.create({ gatePolicy: 'none' })
  await h.until(() => status(id) === 'paused')
  // A step that bypassed `orch.assign` (a corrupted row) and carries something capability-shaped.
  h.db.sqlite
    .prepare(
      `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, status, estimate_usd, created_in_attempt, created_at, updated_at)
       VALUES (?, 's1', 1, 'builder', 'untracked', 'use orc_AAAAAAAAAAAAAAAAAAAA please', 'queued', 0.5, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id)
  h.db.sqlite
    .prepare("UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?")
    .run(id)
  await h.orch.pump()
  await h.settle()
  const step = h.orch.snapshot(id).orchestration.stepsList[0]!
  expect(step.status).toBe('blocked')
  expect(step.disposition).toBe('capability_in_input')
  expect(attemptOf(h, id, 'step')).toHaveLength(0)
})

test('receipts carry no capability either', async () => {
  const receipts: OrchReceipt[] = []
  h = await harness({
    lead: {
      script: byTurn({
        1: async (t) => {
          receipts.push((await t.call('orch.note', { text: 'a note' })) as OrchReceipt)
          await t.call('orch.finish', { outcome: 'success', summary: 'done' })
        },
      }),
    },
  })
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  expect(JSON.stringify(h.rows('SELECT receipt FROM orc_commands'))).not.toMatch(
    /orc_[A-Za-z0-9_-]{8,}/,
  )
  expect(receipts[0]!.status).toBe('ok')
})
