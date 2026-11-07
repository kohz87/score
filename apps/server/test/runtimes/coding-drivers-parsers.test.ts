import { expect, test } from 'vitest'
import { createClaudeParser } from '../../src/runtimes/coding/claude.ts'
import { createAntigravityParser } from '../../src/runtimes/coding/antigravity.ts'
import { createCodexParser } from '../../src/runtimes/coding/codex.ts'
import { fixtureLines } from './coding-fixtures.ts'
import { parseAll } from './coding-drivers-helpers.ts'

test('claude fixture: session, text, thinking, tool calls with details, usage and result', () => {
  const parser = createClaudeParser('/work')
  const events = parseAll(parser, 'claude-basic')
  expect(events.map((event) => event.kind)).toEqual([
    'session',
    'thinking',
    'text',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'text',
    'usage',
    'result',
  ])
  expect(events[0]).toMatchObject({ sessionId: '11111111-1111-4111-8111-111111111111' })
  expect(events[3]).toMatchObject({
    tool: 'Bash',
    preview: 'ls -la',
    detail: { type: 'command', command: 'ls -la', cwd: '/work' },
  })
  expect(events[5]).toMatchObject({
    tool: 'Write',
    detail: { type: 'write', path: '/work/hello.txt' },
  })
  expect(events[7]).toMatchObject({ detail: { type: 'replace', oldString: 'world' } })
  // Text after a tool call starts a new paragraph.
  expect(events[9]).toMatchObject({ kind: 'text', text: '\n\nCreated hello.txt and changed it.' })
  expect(events[10]).toMatchObject({
    kind: 'usage',
    inputTokens: 1350,
    outputTokens: 340,
    costUsd: 0.0123,
  })
  expect(events[11]).toMatchObject({ kind: 'result', ok: true })
  // The rate-limit record (kept for the quota meter, never an event) is the one record counted as ignorable.
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('claude: unknown shapes and malformed lines are counted and dropped, never stored', () => {
  const parser = createClaudeParser()
  const lines = ['this line is not json', ...fixtureLines('claude-unknown')]
  const events = lines.flatMap((line) => parser.parse(line))
  expect(events.map((event) => event.kind)).toEqual(['session', 'text', 'result'])
  expect(parser.stats.malformed).toBeGreaterThanOrEqual(1)
  expect(parser.stats.unknown).toBe(3)
})

test('claude: an error result is a failed result with the CLI’s message', () => {
  const events = parseAll(createClaudeParser(), 'claude-error')
  expect(events.at(-1)).toMatchObject({
    kind: 'result',
    ok: false,
    text: 'The model request failed',
    error: 'The model request failed',
    verdict: { eligible: false, reply: null },
  })
})

test('codex fixture: thread, commands, file changes, message, usage without cost', () => {
  const parser = createCodexParser('/work')
  const events = parseAll(parser, 'codex-basic')
  expect(events.map((event) => event.kind)).toEqual([
    'session',
    'thinking',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'tool_start',
    'tool_end',
    'text',
    'usage',
    'result',
  ])
  expect(events[2]).toMatchObject({
    tool: 'Bash',
    detail: { type: 'command', command: 'bash -lc ls', cwd: '/work' },
  })
  expect(events[3]).toMatchObject({ ok: true, exitCode: 0 })
  expect(events[4]).toMatchObject({
    detail: { type: 'file', path: '/work/notes.txt', change: 'update' },
  })
  expect(events[6]).toMatchObject({ detail: { type: 'file', change: 'add' } })
  expect(events[9]).toMatchObject({ ok: false, exitCode: 1 })
  expect(events[11]).toEqual({ kind: 'usage', inputTokens: 2400, outputTokens: 150 })
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('codex: a failed turn carries the CLI’s message; stray error events are not fatal', () => {
  const parser = createCodexParser()
  const events = parseAll(parser, 'codex-failed')
  expect(events.map((event) => event.kind)).toEqual(['session', 'result'])
  expect(events[1]).toMatchObject({ ok: false, error: "You've hit your usage limit." })
  expect(parser.stats.unknown).toBe(1)
})

test('3.14.1: a Claude Code advisor consult (captured shapes, 2.1.312) is a tool call, never loss', () => {
  const parser = createClaudeParser('/work/ws')
  const assistant = (content: object[]) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } })
  const events = [
    assistant([{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }]),
    assistant([
      {
        type: 'advisor_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: { type: 'advisor_redacted_result', encrypted_content: 'Er4ECioIFRgC' },
      },
    ]),
    assistant([{ type: 'text', text: 'Fixed: add should return a + b.' }]),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed.' }),
  ].flatMap((line) => parser.parse(line))
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_start', callId: 'srvtoolu_1', tool: 'advisor' }),
      expect.objectContaining({ kind: 'tool_end', callId: 'srvtoolu_1', ok: true }),
    ]),
  )
  // The encrypted advice never reaches Score's records.
  expect(JSON.stringify(events)).not.toContain('Er4ECioIFRgC')
  expect(parser.lossReason?.() ?? null).toBeNull()
  // An error result is a failed consult, not a lost turn; another server tool is still loss.
  const second = createClaudeParser('/work/ws')
  const failed = second.parse(
    assistant([
      {
        type: 'advisor_tool_result',
        tool_use_id: 'srvtoolu_2',
        content: { type: 'advisor_tool_result_error' },
      },
    ]),
  )
  expect(failed[0]).toMatchObject({ kind: 'tool_end', ok: false })
  expect(second.lossReason?.() ?? null).toBeNull()
  // Inside a sub-agent the consult keeps its parent.
  const nested = createClaudeParser('/work/ws')
  const inner = nested.parse(
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: {
        role: 'assistant',
        content: [{ type: 'server_tool_use', id: 'srvtoolu_4', name: 'advisor', input: {} }],
      },
    }),
  )
  expect(inner[0]).toMatchObject({
    kind: 'tool_start',
    tool: 'advisor',
    parentCallId: 'toolu_parent',
  })
  const third = createClaudeParser('/work/ws')
  third.parse(
    assistant([{ type: 'server_tool_use', id: 'srvtoolu_3', name: 'web_search', input: {} }]),
  )
  expect(third.lossReason?.()).not.toBeNull()
})

test('antigravity fixtures (recorded): a text turn becomes session, text and usage without cost', () => {
  const parser = createAntigravityParser('/work')
  const events = parseAll(parser, 'antigravity-text')
  expect(events.map((event) => event.kind)).toEqual(['session', 'text', 'text', 'usage', 'result'])
  expect(events[0]).toMatchObject({ sessionId: 'aaaaaaaa-1111-4111-8111-000000000001' })
  // The closing DONE step carries the trailing newline: the reply is exactly the streamed deltas.
  expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual([
    'AGY-OK',
    '\n',
  ])
  expect(events[3]).toEqual({ kind: 'usage', inputTokens: 12624, outputTokens: 1567 })
  expect(events[4]).toMatchObject({ kind: 'result', ok: true, verdict: { eligible: true } })
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('antigravity fixtures (recorded): a refused command is a tool card plus a "refused" card, and the turn still completes', () => {
  const parser = createAntigravityParser('/work')
  const events = parseAll(parser, 'antigravity-denied')
  expect(events.map((event) => event.kind)).toEqual([
    'session',
    'tool_start',
    'tool_end',
    'usage',
    'tool_start',
    'tool_end',
    'result',
  ])
  expect(events[1]).toMatchObject({
    tool: 'run_command',
    preview: 'ls -la',
    detail: { type: 'command', command: 'ls -la', cwd: '/work' },
  })
  expect(events[4]).toMatchObject({ tool: 'Antigravity refused', preview: 'RunCommand' })
  expect(events[5]).toMatchObject({ ok: false })
  expect(events[6]).toMatchObject({ kind: 'result', ok: true })
  expect((events[6] as { text: string }).text).toContain('Antigravity refused: RunCommand')
  expect(parser.stats).toEqual({ unknown: 0, malformed: 0 })
})

test('antigravity: file, browser and plain tools map to frame details; unknown shapes are counted', () => {
  const events = parseAll(createAntigravityParser('/work'), 'antigravity-basic')
  const starts = events.filter((e) => e.kind === 'tool_start')
  expect(starts.map((e) => (e as { detail?: unknown }).detail)).toEqual([
    { type: 'command', command: 'ls -la', cwd: '/work' },
    { type: 'file', path: '/work/notes.txt', change: 'update' },
    { type: 'browser', url: 'https://example.test/docs?token=[redacted]#frag' },
    undefined,
  ])
  expect(starts[3]).toMatchObject({ tool: 'view_file', preview: '/work/notes.txt' })
  const parser = createAntigravityParser()
  const lines = ['this is not json', ...fixtureLines('antigravity-unknown')]
  const unknown = lines.flatMap((line) => parser.parse(line))
  expect(unknown.map((event) => event.kind)).toEqual(['session', 'text', 'result'])
  expect(parser.stats).toEqual({ unknown: 2, malformed: 2 })
})

test('antigravity: a failed result carries the CLI’s words, an unknown status is still a failure', () => {
  const events = parseAll(createAntigravityParser(), 'antigravity-error')
  expect(events.at(-1)).toMatchObject({
    kind: 'result',
    ok: false,
    error: 'The model request failed',
    verdict: { eligible: false },
  })
})

test('antigravity: the file tools name their path by TargetFile / AbsolutePath', () => {
  const parser = createAntigravityParser('/work')
  let index = 0
  const line = (tool: string, parameters: object) =>
    JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: ++index,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: tool,
        tool_info: { name: tool, parameters },
      },
    })
  expect(
    parser.parse(line('write_to_file', { TargetFile: '/work/a.txt', CodeContent: 'secret' }))[0],
  ).toMatchObject({
    detail: { type: 'file', path: '/work/a.txt' },
  })
  expect(parser.parse(line('view_file', { AbsolutePath: '/work/b.txt' }))[0]).toMatchObject({
    preview: '/work/b.txt',
  })
})
