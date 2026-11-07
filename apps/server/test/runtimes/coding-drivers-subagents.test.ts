import { expect, test } from 'vitest'
import { createClaudeParser } from '../../src/runtimes/coding/claude.ts'
import { fixtureLines } from './coding-fixtures.ts'
import { parseAll, verdictOf } from './coding-drivers-helpers.ts'

test('8.7: a real Claude Code 2.1.302 turn with a sub-agent: no loss, nesting, sub-agent summary, the result', () => {
  const parser = createClaudeParser('/work/ws')
  const events = parseAll(parser, 'claude-subagent')
  expect(parser.lossReason?.() ?? null).toBeNull()
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
  const agentCall = events.find((event) => event.kind === 'tool_start' && event.tool === 'Agent')
  expect(agentCall).toMatchObject({ kind: 'tool_start', preview: expect.any(String) })
  expect(agentCall).not.toHaveProperty('parentCallId')
  const callId = (agentCall as { callId: string }).callId
  // The sub-agent's own tool call and its result carry the Agent call as parent.
  expect(events.filter((event) => event.kind === 'tool_start' && event.tool === 'Bash')).toEqual([
    expect.objectContaining({ parentCallId: callId }),
  ])
  const nested = events.filter((event) => event.kind === 'tool_end' && event.parentCallId)
  expect(nested).toHaveLength(1)
  // The Agent tool's own end is the main agent's: no parent.
  expect(
    events.find((event) => event.kind === 'tool_end' && event.callId === callId),
  ).not.toHaveProperty('parentCallId')
  const subs = events.filter((event) => event.kind === 'subagent')
  expect(subs.map((event) => [event.callId, event.status])).toEqual([
    [callId, 'running'],
    [callId, 'running'],
    [callId, 'done'],
    [callId, 'done'],
  ])
  expect(agentCall).toMatchObject({ preview: 'List files in folder' })
  expect(subs[0]).toMatchObject({
    description: 'List files in folder',
    subagentType: 'general-purpose',
  })
  expect(subs[1]).toMatchObject({ toolCalls: 1, durationMs: 2336, totalTokens: 15882 })
  // The sub-agent's own prose is not the turn's reply; the verdict is the result record's.
  const result = events.find((event) => event.kind === 'result')
  expect(result).toMatchObject({ ok: true, verdict: { eligible: true } })
  expect(verdictOf(events)?.reply).toContain('README.txt')
})

test('3.10.0: Claude Code’s own ttft_ms rides on the usage event; absent stays absent', () => {
  const withTtft = parseAll(createClaudeParser('/work/ws'), 'claude-subagent')
  expect(withTtft.find((event) => event.kind === 'usage')).toMatchObject({ ttftMs: 5443 })
  const without = parseAll(createClaudeParser('/work/ws'), 'claude-basic')
  expect(without.find((event) => event.kind === 'usage')).not.toHaveProperty('ttftMs')
})

test('8.7: a failed sub-agent is visible on the sub-agent; the turn still follows the result record', () => {
  const lines = fixtureLines('claude-subagent').map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    if (record.subtype === 'task_notification') record.status = 'failed'
    if (record.subtype === 'task_updated') record.patch = { status: 'failed', end_time: 1 }
    return JSON.stringify(record)
  })
  const parser = createClaudeParser('/work/ws')
  const events = lines.flatMap((line) => parser.parse(line))
  const subs = events.filter((event) => event.kind === 'subagent')
  expect(subs.at(-1)).toMatchObject({ status: 'failed' })
  expect(subs.at(-2)).toMatchObject({ status: 'failed' })
  expect(parser.lossReason?.() ?? null).toBeNull()
  expect(verdictOf(events)?.eligible).toBe(true)
  // And a failed result still fails the turn whatever the sub-agent did.
  const failedTurn = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    if (record.type === 'result')
      return JSON.stringify({ ...record, is_error: true, subtype: 'error_during_execution' })
    return line
  })
  const second = createClaudeParser('/work/ws')
  const failed = failedTurn.flatMap((line) => second.parse(line))
  expect(verdictOf(failed)?.eligible).toBe(false)
})

test('8.7: sub-agent record shapes outside the captured ones, and unknown system subtypes, are still loss', () => {
  const run = (extra: object[]) => {
    const parser = createClaudeParser()
    const success = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
    })
    const lines = [...extra.map((record) => JSON.stringify(record)), success]
    lines.forEach((line) => parser.parse(line))
    return parser.lossReason?.() ?? null
  }
  const started = {
    type: 'system',
    subtype: 'task_started',
    task_id: 't1',
    tool_use_id: 'toolu_1',
    description: 'Look',
  }
  expect(run([started])).toBeNull()
  expect(run([{ type: 'system', subtype: 'task_made_up', task_id: 't1' }])).not.toBeNull()
  expect(run([{ ...started, task_id: undefined }])).not.toBeNull()
  expect(run([{ ...started, is_error: true }])).not.toBeNull()
  expect(run([{ ...started, tool_use_id: '' }])).not.toBeNull()
  // task_updated for a task that never started cannot be placed.
  expect(
    run([
      { type: 'system', subtype: 'task_updated', task_id: 'ghost', patch: { status: 'completed' } },
    ]),
  ).not.toBeNull()
  expect(
    run([started, { type: 'system', subtype: 'task_updated', task_id: 't1', patch: 'completed' }]),
  ).not.toBeNull()
  // Progress with a malformed usage block.
  expect(
    run([{ ...started, subtype: 'task_progress', usage: { total_tokens: 'many' } }]),
  ).not.toBeNull()
  // After the result they are as suspicious as any other notice.
  const parser = createClaudeParser()
  parser.parse(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }),
  )
  parser.parse(JSON.stringify(started))
  expect(parser.lossReason?.()).not.toBeNull()
})
