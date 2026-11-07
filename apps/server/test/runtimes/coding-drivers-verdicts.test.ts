import { expect, test } from 'vitest'
import { createClaudeParser } from '../../src/runtimes/coding/claude.ts'
import { createAntigravityParser } from '../../src/runtimes/coding/antigravity.ts'
import { createCodexParser } from '../../src/runtimes/coding/codex.ts'
import type { CodingEvent } from '../../src/runtimes/coding/types.ts'
import {
  agentMessage,
  claudeResult,
  codexLine,
  finalMessage,
  runCodex,
  turnCompleted,
  verdictOf,
} from './coding-drivers-helpers.ts'

test('claude: only an explicit success with text is eligible; defaults never imply success (7.7a section 6)', () => {
  const run = (fields: Record<string, unknown>) =>
    verdictOf(createClaudeParser().parse(claudeResult(fields)))
  expect(run({ subtype: 'success', is_error: false, result: 'Done.' })).toEqual({
    eligible: true,
    reply: 'Done.',
    reason: null,
  })
  // Each default is a refusal: no subtype, no is_error, no text, empty text, an error flag, another subtype.
  for (const fields of [
    { is_error: false, result: 'Done.' },
    { subtype: 'success', result: 'Done.' },
    { subtype: 'success', is_error: false },
    { subtype: 'success', is_error: false, result: '   ' },
    { subtype: 'success', is_error: true, result: 'Done.' },
    { subtype: 'error_max_turns', is_error: false, result: 'Done.' },
  ])
    expect(run(fields)?.eligible, JSON.stringify(fields)).toBe(false)
})

test('codex: the reply is the last validated agent_message before turn.completed (7.7a section 6)', () => {
  const parser = createCodexParser()
  const events = [
    agentMessage('m1', 'First thoughts.'),
    agentMessage('m2', 'The final answer.'),
    turnCompleted,
  ].flatMap((line) => parser.parse(line))
  expect(verdictOf(events)).toEqual({ eligible: true, reply: 'The final answer.', reason: null })
})

test('codex: a malformed or empty agent_message, a dropped record or no message at all leaves no authority', () => {
  const run = (lines: string[]) => {
    const parser = createCodexParser()
    return verdictOf(lines.flatMap((line) => parser.parse(line)))
  }
  // A completed message with the wrong shape or no text invalidates the whole turn, even with a good one after it.
  expect(run([agentMessage('m1', 42), agentMessage('m2', 'Fine.'), turnCompleted])?.eligible).toBe(
    false,
  )
  expect(run([agentMessage('m1', ''), agentMessage('m2', 'Fine.'), turnCompleted])?.eligible).toBe(
    false,
  )
  expect(run([agentMessage('m1', '  \n'), turnCompleted])?.eligible).toBe(false)
  // An unparseable line inside the turn is a dropped record.
  expect(run([agentMessage('m1', 'Fine.'), 'not json at all', turnCompleted])?.eligible).toBe(false)
  // A turn that said nothing, and a failed turn.
  expect(run([turnCompleted])?.eligible).toBe(false)
  expect(
    run([agentMessage('m1', 'Fine.'), codexLine({ type: 'turn.failed', error: { message: 'x' } })])
      ?.eligible,
  ).toBe(false)
  // Messages still streaming (not completed) are not validated messages.
  expect(run([agentMessage('m1', 'Part', 'item.updated'), turnCompleted])?.eligible).toBe(false)
})

test('codex: a malformed agent_message (no or bad id, bad updated shape) invalidates authority, review #3', () => {
  const run = (lines: string[]) => {
    const parser = createCodexParser()
    return verdictOf(lines.flatMap((line) => parser.parse(line)))
  }
  const noId = (type = 'item.completed') =>
    codexLine({ type, item: { type: 'agent_message', text: 'Final.' } })
  const badId = codexLine({
    type: 'item.completed',
    item: { id: '', type: 'agent_message', text: 'Final.' },
  })
  expect(run([agentMessage('m1', 'Preliminary.'), noId(), turnCompleted])?.eligible).toBe(false)
  expect(run([agentMessage('m1', 'Preliminary.'), badId, turnCompleted])?.eligible).toBe(false)
  expect(
    run([agentMessage('m1', 'Preliminary.'), agentMessage('m2', 7, 'item.updated'), turnCompleted])
      ?.eligible,
  ).toBe(false)
  expect(
    run([agentMessage('m1', 'Preliminary.'), noId('item.updated'), turnCompleted])?.eligible,
  ).toBe(false)
  // The loss is sticky: a good message after it does not restore authority.
  expect(run([noId(), agentMessage('m2', 'Fine.'), turnCompleted])?.eligible).toBe(false)
})

test('codex: loss is sticky for the whole attempt; a later turn in the same stream is not authoritative either (re-review #3)', () => {
  const parser = createCodexParser()
  const first = ['bad', agentMessage('m1', 'A'), turnCompleted].flatMap((l) => parser.parse(l))
  expect(verdictOf(first)?.eligible).toBe(false)
  const second = [agentMessage('m2', 'B'), turnCompleted].flatMap((l) => parser.parse(l))
  // The first terminal closed the attempt: the second yields no verdict at all (FT #1) and the loss stays.
  expect(verdictOf(second)).toBeUndefined()
  expect(parser.lossReason?.()).toBeTruthy()
})

test('codex: an item record with no item, or a malformed started message, leaves no authority (re-review #3)', () => {
  const run = (lines: string[]) => {
    const parser = createCodexParser()
    const events = lines.flatMap((line) => parser.parse(line))
    return { verdict: verdictOf(events), loss: parser.lossReason?.() ?? null }
  }
  const nullItem = codexLine({ type: 'item.completed', item: null })
  const startedNoText = codexLine({
    type: 'item.started',
    item: { id: 'm3', type: 'agent_message' },
  })
  expect(run([agentMessage('m1', 'Final.'), nullItem, turnCompleted]).verdict?.eligible).toBe(false)
  expect(run([agentMessage('m1', 'Final.'), startedNoText, turnCompleted]).verdict?.eligible).toBe(
    false,
  )
  expect(run([agentMessage('m1', 'Final.'), turnCompleted]).loss).toBeNull()
})

test('codex: a record dropped or invalid after turn.completed still takes the authority away, asked once the stream is done (re-review #3)', () => {
  const parser = createCodexParser()
  const events = [agentMessage('m1', 'Final.'), turnCompleted].flatMap((l) => parser.parse(l))
  expect(verdictOf(events)?.eligible).toBe(true)
  expect(parser.lossReason?.()).toBeNull()
  parser.parse('not json at all')
  expect(parser.lossReason?.()).toBeTruthy()
  const other = createCodexParser()
  ;[agentMessage('m1', 'Final.'), turnCompleted].forEach((l) => other.parse(l))
  other.parse(codexLine({ type: 'item.completed', item: null }))
  expect(other.lossReason?.()).toBeTruthy()
})

test('antigravity: SUCCESS and a non-empty response are eligible, and the response wins over commentary (7.7a section 6)', () => {
  const result = (status: string, response: string | undefined) =>
    JSON.stringify({
      event: 'result',
      result: { status, ...(response === undefined ? {} : { response }) },
    })
  const parse = (status: string, response: string | undefined) =>
    verdictOf(createAntigravityParser().parse(result(status, response)))
  expect(parse('SUCCESS', 'The answer.')).toEqual({
    eligible: true,
    reply: 'The answer.',
    reason: null,
  })
  expect(parse('SUCCESS', '   ')?.eligible).toBe(false)
  expect(parse('SUCCESS', undefined)?.eligible).toBe(false)
  expect(parse('ERROR', 'The answer.')?.eligible).toBe(false)
  expect(parse('success', 'The answer.')?.eligible).toBe(false)
})

test('#1: any rejected recognised Codex record takes the authority of the attempt, terminal ones and later ones too', () => {
  const rejected: Record<string, string> = {
    'command with no command': codexLine({
      type: 'item.completed',
      item: { id: 'c1', type: 'command_execution' },
    }),
    'file change with bad changes': codexLine({
      type: 'item.completed',
      item: { id: 'f1', type: 'file_change', changes: 'nope' },
    }),
    'mcp call without a tool': codexLine({
      type: 'item.completed',
      item: { id: 'x1', type: 'mcp_tool_call' },
    }),
    'search without a query': codexLine({
      type: 'item.completed',
      item: { id: 's1', type: 'web_search' },
    }),
    'reasoning without text': codexLine({
      type: 'item.completed',
      item: { id: 'r1', type: 'reasoning' },
    }),
  }
  for (const [name, line] of Object.entries(rejected)) {
    // Before the terminal record and after it: the verdict is decided once the whole stream was processed.
    const before = runCodex([finalMessage, line, turnCompleted])
    expect(before.verdict?.eligible, name).toBe(false)
    const after = runCodex([finalMessage, turnCompleted, line])
    expect(after.lost, name).not.toBeNull()
  }
  // Malformed terminal records.
  const badCompleted = codexLine({ type: 'turn.completed', usage: 'many' })
  const badFailed = codexLine({ type: 'turn.failed', error: 7 })
  expect(runCodex([finalMessage, turnCompleted, badFailed]).lost).not.toBeNull()
  expect(runCodex([finalMessage, badCompleted]).lost).not.toBeNull()
  expect(runCodex([finalMessage, badCompleted, turnCompleted]).verdict?.eligible).toBe(false)
  // A clean attempt keeps its authority.
  const clean = runCodex([finalMessage, turnCompleted])
  expect(clean.verdict?.eligible).toBe(true)
  expect(clean.lost).toBeNull()
})

test('#18: ids, tool details and candidate replies are bounded, and the parser reports what it really holds', () => {
  const parser = createCodexParser()
  const hugeId = 'i'.repeat(200_000)
  const events: CodingEvent[] = []
  for (let n = 0; n < 64; n++)
    events.push(
      ...parser.parse(
        codexLine({
          type: 'item.started',
          item: { id: `${hugeId}${n}`, type: 'command_execution', command: 'c'.repeat(500_000) },
        }),
      ),
    )
  const starts = events.filter((e) => e.kind === 'tool_start')
  expect(starts).toHaveLength(64)
  for (const start of starts) {
    expect(Buffer.byteLength(start.callId)).toBeLessThanOrEqual(256)
    if (start.detail?.type === 'command')
      expect(Buffer.byteLength(start.detail.command)).toBeLessThanOrEqual(16 * 1024)
  }
  // Distinct long ids stay distinct, and the same id maps to the same short id (the end pairs with the start).
  expect(new Set(starts.map((s) => s.callId)).size).toBe(64)
  expect(parser.retainedBytes!()).toBeLessThan(64 * 300)
  // A candidate reply past the limit is never an authoritative reply.
  const big = runCodex([agentMessage('m1', 'r'.repeat(300 * 1024)), turnCompleted])
  expect(big.verdict?.eligible).toBe(false)
  const ok = createCodexParser()
  ;[agentMessage('m1', 'r'.repeat(100 * 1024)), turnCompleted].forEach((l) => ok.parse(l))
  expect(ok.retainedBytes!()).toBeGreaterThanOrEqual(100 * 1024)
})

test('#18: Claude and Antigravity results and tool details are bounded too', () => {
  const claude = createClaudeParser()
  const events = claude.parse(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't'.repeat(10_000),
            name: 'Bash',
            input: { command: 'c'.repeat(300_000) },
          },
        ],
      },
    }),
  )
  const start = events.find((e) => e.kind === 'tool_start')!
  expect(start.kind === 'tool_start' && Buffer.byteLength(start.callId)).toBeLessThanOrEqual(256)
  const result = claude.parse(claudeResult({ result: 'r'.repeat(400 * 1024) }))
  expect(verdictOf(result)).toMatchObject({ eligible: false })
})

test('a real Claude Code read-only turn (record order and shapes captured 2026-10-13, ids stripped) keeps its success', () => {
  const parser = createClaudeParser()
  const lines = [
    {
      type: 'system',
      subtype: 'init',
      session_id: '88888888-8888-4888-8888-888888888888',
      tools: [],
      cwd: '/w',
    },
    {
      type: 'system',
      subtype: 'commands_changed',
      session_id: '88888888-8888-4888-8888-888888888888',
      commands: [],
    },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1 },
  ]
  const events = lines.flatMap((line) => parser.parse(JSON.stringify(line)))
  expect(parser.lossReason?.() ?? null).toBeNull()
  expect(verdictOf(events)?.eligible).toBe(true)
})
