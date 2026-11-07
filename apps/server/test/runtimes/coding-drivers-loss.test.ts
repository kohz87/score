import { expect, test } from 'vitest'
import { createClaudeParser } from '../../src/runtimes/coding/claude.ts'
import { createAntigravityParser } from '../../src/runtimes/coding/antigravity.ts'
import { createCodexParser } from '../../src/runtimes/coding/codex.ts'
import { fixtureLines } from './coding-fixtures.ts'
import {
  agentMessage,
  claudeResult,
  codexLine,
  finalMessage,
  runCodex,
  turnCompleted,
  verdictOf,
} from './coding-drivers-helpers.ts'

test('FW #5: Codex unknown records are loss unless explicitly allow-listed', () => {
  const unknownTop = codexLine({ type: 'mystery.notice', note: 'x' })
  const unknownItem = codexLine({ type: 'item.completed', item: { id: 'u1', type: 'hologram' } })
  expect(runCodex([finalMessage, turnCompleted, unknownTop]).lost).not.toBeNull()
  expect(runCodex([finalMessage, unknownItem, turnCompleted]).verdict?.eligible).toBe(false)
  // Allow-listed: a todo list item, the retry notice.
  const todo = codexLine({ type: 'item.completed', item: { id: 't1', type: 'todo_list' } })
  const notice = codexLine({ type: 'error', message: 'Reconnecting... 1/5' })
  const clean = runCodex([finalMessage, todo, notice, turnCompleted])
  expect(clean.lost).toBeNull()
  expect(clean.verdict?.eligible).toBe(true)
})

test('FW #5: Claude Code gets the same final loss check: rejected and unknown records take the authority', () => {
  const run = (lines: string[]) => {
    const parser = createClaudeParser()
    const events = lines.flatMap((line) => parser.parse(line))
    return { verdict: verdictOf(events), lost: parser.lossReason?.() ?? null }
  }
  const success = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
  })
  const rejectedError = JSON.stringify({
    type: 'result',
    subtype: 'error',
    is_error: 'yes',
    result: 'It failed.',
  })
  expect(run([success]).lost).toBeNull()
  expect(run([success, rejectedError]).lost).not.toBeNull()
  expect(run([success, JSON.stringify({ type: 'mystery' })]).lost).not.toBeNull()
  expect(run([success, JSON.stringify({ type: 'assistant', message: 7 })]).lost).not.toBeNull()
  expect(run([success, 'not json']).lost).not.toBeNull()
  const badBlock = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash' }] },
  })
  expect(run([success, badBlock]).lost).not.toBeNull()
  // Allow-listed notices keep the authority.
  const notices = [
    JSON.stringify({ type: 'stream_event', event: {} }),
    JSON.stringify({ type: 'rate_limit_event' }),
    JSON.stringify({ type: 'system', subtype: 'hook_started' }),
  ]
  expect(run([...notices, success]).lost).toBeNull()
})

test('FW #5: Antigravity unknown records are loss; telemetry is allow-listed', () => {
  const parser = createAntigravityParser()
  parser.parse(JSON.stringify({ event: 'telemetry', x: 1 }))
  expect(parser.lossReason?.()).toBeNull()
  parser.parse(JSON.stringify({ event: 'mystery' }))
  expect(parser.lossReason?.()).not.toBeNull()
})

test('FV #3: Codex `error` records are ignorable only as a validated retry notice before the turn ended', () => {
  const fatal = codexLine({ type: 'error', message: 'fatal: the final output was lost' })
  const retry = codexLine({ type: 'error', message: 'Reconnecting... 2/5' })
  const malformed = codexLine({ type: 'error', message: { nested: true } })
  const noMessage = codexLine({ type: 'error' })
  // The probe of re-review 4: a validated answer and turn.completed, then an error claiming fatal output loss.
  const late = runCodex([finalMessage, turnCompleted, fatal])
  expect(late.lost).not.toBeNull()
  expect(late.verdict?.eligible).toBe(true) // the verdict was already given; the final loss check takes the authority
  // A retry notice after the verdict is still too late to be a notice about the turn.
  expect(runCodex([finalMessage, turnCompleted, retry]).lost).not.toBeNull()
  // Before the verdict: an error that reports a failure, a malformed one and one without a message all lose it.
  expect(runCodex([finalMessage, fatal, turnCompleted]).lost).not.toBeNull()
  expect(runCodex([finalMessage, malformed, turnCompleted]).lost).not.toBeNull()
  expect(runCodex([finalMessage, noMessage, turnCompleted]).lost).not.toBeNull()
  // The retry notice before the verdict keeps it.
  const clean = runCodex([retry, finalMessage, turnCompleted])
  expect(clean.lost).toBeNull()
  expect(clean.verdict?.eligible).toBe(true)
})

test('FU #2: only the anchored `Reconnecting... n/m` notice is harmless; messages that merely mention a retry are loss', () => {
  const text = (message: string) => codexLine({ type: 'error', message })
  for (const message of [
    'stream disconnected: fatal output loss; no retries remain',
    'Retrying fatal',
    'reconnecting... 1/5',
    'Reconnecting... 0/5',
    'Reconnecting... 6/5',
    'Reconnecting... x/5',
    ' Reconnecting... 1/5',
    'error: Reconnecting... 1/5',
  ]) {
    expect(runCodex([finalMessage, text(message), turnCompleted]).lost, message).not.toBeNull()
    expect(runCodex([text(message), finalMessage, turnCompleted]).lost, message).not.toBeNull()
  }
  // Extra fields that could report a failure are not a plain notice either.
  const extra = codexLine({ type: 'error', message: 'Reconnecting... 1/5', fatal: true })
  expect(runCodex([extra, finalMessage, turnCompleted]).lost).not.toBeNull()
  // The anchored form, with a reason after it, is the notice.
  const reason = text('Reconnecting... 2/5 (stream disconnected before completion)')
  expect(runCodex([reason, finalMessage, turnCompleted]).lost).toBeNull()
})

test('FV #3: Claude Code system records: only known notices that report no error, and only before the result', () => {
  const run = (lines: string[]) => {
    const parser = createClaudeParser()
    const events = lines.flatMap((line) => parser.parse(line))
    return { verdict: verdictOf(events), lost: parser.lossReason?.() ?? null }
  }
  const success = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
  })
  const system = (extra: object) => JSON.stringify({ type: 'system', ...extra })
  expect(run([system({ subtype: 'hook_started' }), success]).lost).toBeNull()
  expect(run([system({ subtype: 'api_retry', error: 'overloaded' }), success]).lost).toBeNull()
  // The probe of re-review 4: an unknown system error record after a clean success.
  expect(run([success, system({ subtype: 'error', message: 'output lost' })]).lost).not.toBeNull()
  expect(run([system({ subtype: 'fatal_error' }), success]).lost).not.toBeNull()
  // A known subtype that reports an error, a record with no subtype, and a notice after the result.
  expect(run([system({ subtype: 'hook_response', is_error: true }), success]).lost).not.toBeNull()
  expect(run([system({}), success]).lost).not.toBeNull()
  expect(run([success, system({ subtype: 'hook_started' })]).lost).not.toBeNull()
  // 3.8.2: print-mode notices of Claude Code 2.1.311 (shapes from its own code), before the result.
  for (const notice of [
    { subtype: 'thinking_tokens', estimated_tokens: 1200, estimated_tokens_delta: 40 },
    {
      subtype: 'permission_denied',
      tool_name: 'Read',
      tool_use_id: 'toolu_1',
      agent_id: null,
      decision_reason_type: 'rule',
    },
    { subtype: 'background_tasks_changed', tasks: [] },
  ])
    expect(run([system(notice), success]).lost, notice.subtype).toBeNull()
  // The loss names the record's kind, never its content, and says when it came after the result.
  expect(run([system({ subtype: 'brand_new_thing', secret: 'x' }), success]).lost).toContain(
    '(system/brand_new_thing)',
  )
  expect(run([success, system({ subtype: 'thinking_tokens' })]).lost).toContain(
    '(system/thinking_tokens, after the result)',
  )
  expect(run([system({ subtype: 'Not An Identifier!' }), success]).lost).toContain('(system)')
})

test('FT #1: codex turn.failed followed by a message and turn.completed is loss; the failure is never replaced', () => {
  const parser = createCodexParser()
  const events = [
    codexLine({ type: 'turn.failed', error: { message: 'x' } }),
    agentMessage('m1', 'All done.'),
    turnCompleted,
  ].flatMap((line) => parser.parse(line))
  expect(events.filter((event) => event.kind === 'result')).toHaveLength(1)
  expect(verdictOf(events)?.eligible).toBe(false)
  expect(parser.lossReason?.()).toBeTruthy()
})

test('FT #1: codex turn.completed followed by turn.failed, or by a second completion, is loss', () => {
  for (const second of [
    codexLine({ type: 'turn.failed', error: { message: 'x' } }),
    turnCompleted,
  ]) {
    const parser = createCodexParser()
    const events = [agentMessage('m1', 'Done.'), turnCompleted, second].flatMap((line) =>
      parser.parse(line),
    )
    expect(events.filter((event) => event.kind === 'result')).toHaveLength(1)
    expect(parser.lossReason?.()).toBeTruthy()
  }
})

test('FT #1: claude error result followed by an explicit success is loss and the first result stands', () => {
  const parser = createClaudeParser()
  const events = [
    claudeResult({ subtype: 'error_during_execution', is_error: true, result: 'x' }),
    claudeResult({ subtype: 'success', is_error: false, result: 'Done.' }),
  ].flatMap((line) => parser.parse(line))
  expect(events.filter((event) => event.kind === 'result')).toHaveLength(1)
  expect(verdictOf(events)?.eligible).toBe(false)
  expect(parser.lossReason?.()).toBeTruthy()
})

test('fix-argon A2: Claude Code activity after the result (assistant text or tool use, a tool result) takes the authority away', () => {
  const baseLines = fixtureLines('claude-basic')
  const after: Record<string, string> = {
    text: JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'One more thing.' }] },
    }),
    stringText: JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'One more thing.' },
    }),
    toolUse: JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_late', name: 'Bash', input: { command: 'rm x' } }],
      },
    }),
    toolResult: JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'late', is_error: false },
        ],
      },
    }),
  }
  const clean = createClaudeParser('/work')
  baseLines.forEach((line) => clean.parse(line))
  expect(clean.lossReason?.()).toBeNull()
  for (const [name, line] of Object.entries(after)) {
    const parser = createClaudeParser('/work')
    baseLines.forEach((l) => parser.parse(l))
    parser.parse(line)
    expect(parser.lossReason?.(), name).toBeTruthy()
  }
})

test('fix-argon A2: a Codex tool or command item after turn.completed takes the authority away', () => {
  const items = [
    codexLine({
      type: 'item.started',
      item: { id: 'c9', type: 'command_execution', command: 'rm x', status: 'in_progress' },
    }),
    codexLine({
      type: 'item.completed',
      item: {
        id: 'f9',
        type: 'file_change',
        changes: [{ path: '/w/x', kind: 'add' }],
        status: 'completed',
      },
    }),
    codexLine({
      type: 'item.completed',
      item: { id: 'w9', type: 'web_search', query: 'q' },
    }),
  ]
  for (const line of items) {
    const parser = createCodexParser()
    ;[agentMessage('m1', 'Final.'), turnCompleted].forEach((l) => parser.parse(l))
    expect(parser.lossReason?.()).toBeNull()
    parser.parse(line)
    expect(parser.lossReason?.(), line).toBeTruthy()
  }
})
