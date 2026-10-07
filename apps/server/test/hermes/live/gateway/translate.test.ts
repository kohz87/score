import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { readRun, runSummary, translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import { fixture } from './fake-gateway.ts'
import { setup } from './helpers.ts'

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})

async function admitted() {
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    'fixture-turn',
  )
  return { profile: 'builder', runId, credentialGeneration: 1 }
}

test.each(['l2', 'l4a'] as const)(
  '%s replay pairs tools, resolves waiting and commits validated drafts and tokens',
  async (name) => {
    const context = await admitted()
    const metrics = { unknownEvents: 0 }
    const events = fixture(name)
    const statuses: string[] = []
    for (const event of events) {
      await env.ingest.submit(
        translateRunEvent(context, { ...event, run_id: context.runId }, metrics),
      )
      if (event.event === 'approval.request')
        expect(readRun(env.db.sqlite, context.runId).status).toBe('waiting_for_approval')
      if (event.event === 'approval.responded' || event.event === 'tool.completed')
        expect(readRun(env.db.sqlite, context.runId).status).toBe('running')
      statuses.push(readRun(env.db.sqlite, context.runId).status)
    }
    const tools = env.db.sqlite.prepare('SELECT * FROM tool_calls ORDER BY seq').all()
    const starts = events.filter((event) => event.event === 'tool.started')
    const completions = events.filter((event) => event.event === 'tool.completed')
    expect(tools).toHaveLength(starts.length)
    for (const [index, tool] of tools.entries()) {
      expect(tool).toMatchObject({
        seq: starts[index]!.seq,
        tool: starts[index]!.tool,
        status: completions[index]!.error ? 'error' : 'ok',
        duration_ms: Math.round(Number(completions[index]!.duration) * 1000),
      })
      expect(String(tool.result_preview).length).toBeLessThanOrEqual(500)
    }
    expect(runSummary(env.db.sqlite, context.runId)).toMatchObject({
      status: 'completed',
      toolsUsed: ['terminal'],
      tokens: name === 'l2' ? { input: 51481, output: 143 } : { input: 38465, output: 202 },
    })
    expect(statuses).toContain('waiting_for_approval')
    expect(
      env.db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'log.line'").get()?.n,
    ).toBe(starts.length + completions.length + 1)
    expect(
      env.db.sqlite.prepare('SELECT cursor, incarnation FROM ingest_checkpoints').get(),
    ).toEqual({ cursor: String(events.at(-1)!.seq), incarnation: 'builder:g1' })
    expect(env.db.sqlite.prepare('SELECT * FROM tool_calls').all()).toEqual(tools)
    for (const event of events)
      expect(
        await env.ingest.submit(
          translateRunEvent(context, { ...event, run_id: context.runId }, metrics),
        ),
      ).toEqual({ status: 'duplicate' })
    expect(env.db.sqlite.prepare('SELECT * FROM tool_calls ORDER BY seq').all()).toEqual(tools)
    expect(metrics.unknownEvents).toBe(0)
  },
)

test('unknown and text events advance the cursor, produce no drafts and count unknown once', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const unknown = {
    event: 'future.feature',
    seq: 0,
    timestamp: 1791290587,
    run_id: context.runId,
    token: 'never-store-this',
  }
  const before = env.db.sqlite.prepare('SELECT * FROM events').all()
  await env.ingest.submit(translateRunEvent(context, unknown, metrics))
  await env.ingest.submit(translateRunEvent(context, unknown, metrics))
  await env.ingest.submit(
    translateRunEvent(context, { ...unknown, event: 'message.delta', seq: 1 }, metrics),
  )
  expect(metrics.unknownEvents).toBe(1)
  expect(env.db.sqlite.prepare('SELECT * FROM events').all()).toEqual(before)
  expect(readRun(env.db.sqlite, context.runId)).toMatchObject({
    last_seq: 1,
    status: 'queued',
    version: 0,
  })
  expect(env.db.sqlite.prepare('SELECT cursor FROM ingest_checkpoints').get()?.cursor).toBe('1')
})

test('older observations and newer delayed tools cannot regress terminal state', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587, tool: 'terminal', preview: 'ls' }
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'run.completed', seq: 10, output: 'done' },
      metrics,
    ),
  )
  const terminal = readRun(env.db.sqlite, context.runId)
  for (const seq of [2, 11])
    await env.ingest.submit(
      translateRunEvent(context, { ...base, event: 'tool.started', seq }, metrics),
    )
  await env.ingest.submit(
    translateRunEvent(context, { ...base, event: 'run.failed', seq: 12, error: 'late' }, metrics),
  )
  expect(readRun(env.db.sqlite, context.runId)).toEqual(terminal)
  expect(env.db.sqlite.prepare('SELECT * FROM tool_calls').all()).toEqual([])
  expect(env.db.sqlite.prepare('SELECT cursor FROM ingest_checkpoints').get()?.cursor).toBe('12')
})

test('completion selects the latest running tool with the same name', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587, tool: 'terminal', preview: 'ls' }
  for (const seq of [0, 1])
    await env.ingest.submit(
      translateRunEvent(context, { ...base, seq, event: 'tool.started' }, metrics),
    )
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, seq: 2, event: 'tool.completed', duration: 0.123, error: false },
      metrics,
    ),
  )
  expect(env.db.sqlite.prepare('SELECT seq, status FROM tool_calls ORDER BY seq').all()).toEqual([
    { seq: 0, status: 'running' },
    { seq: 1, status: 'ok' },
  ])
})

test('redacts before truncating tools, approvals, terminal output and error', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587 }
  const secret = 'sk-abcdefghijklmnopqrstuv'
  const long = 'x'.repeat(490) + ` ${secret}`
  const values = [
    { event: 'tool.started', tool: 'terminal', preview: `TOKEN=${secret}` },
    { event: 'approval.request', command: `Bearer ${secret}`, description: 'why', token: secret },
    { event: 'tool.completed', tool: 'terminal', preview: long, duration: 2, error: true },
    { event: 'run.failed', output: '🐈'.repeat(2047) + ` ${secret}`, error: `password=${secret}` },
  ]
  for (const [seq, value] of values.entries())
    await env.ingest.submit(translateRunEvent(context, { ...base, ...value, seq }, metrics))
  const row = readRun(env.db.sqlite, context.runId)
  expect(Buffer.byteLength(row.output!)).toBeLessThanOrEqual(8192)
  expect(row.error).toContain('[redacted]')
  expect(JSON.stringify(env.db.sqlite.prepare('SELECT * FROM tool_calls').all())).not.toContain(
    secret,
  )
  expect(JSON.stringify(env.db.sqlite.prepare('SELECT * FROM events').all())).not.toContain(secret)
})

test('rejects malformed known events and wrong run before projection or cursor writes', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  expect(() =>
    translateRunEvent(
      context,
      { event: 'tool.completed', run_id: context.runId, timestamp: 1791290587, seq: 0 },
      metrics,
    ),
  ).toThrow()
  expect(() =>
    translateRunEvent(
      context,
      { event: 'future', run_id: 'different', timestamp: 1791290587, seq: 0 },
      metrics,
    ),
  ).toThrow('different run')
  expect(env.db.sqlite.prepare('SELECT * FROM ingest_checkpoints').all()).toEqual([])
})
