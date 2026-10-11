import { createHash } from 'node:crypto'
import { WORKFLOW_LIMITS } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { parseTemplate, validateDefinition } from '../../src/domain/workflows/definition.ts'
import { cutBytes, parseVerdict, resultFacts } from '../../src/domain/workflows/verdict.ts'
import {
  agent,
  decide,
  definition,
  edge,
  end,
  endRun,
  node,
  replies,
  run,
  runIdOf,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done =
  (id: string, status = 'succeeded') =>
  (): boolean =>
    run(h!, id).status === status
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const block = (verdict: string, reason = 'because') =>
  '```score-verdict\n' + JSON.stringify({ verdict, reason }) + '\n```'

// -------------------------------------------------------------------------------------------------- verdict parser

test('verdicts: exactly one valid block, otherwise none', () => {
  expect(parseVerdict(`Review.\n${block('passed')}\nDone.`)).toEqual({
    verdict: 'passed',
    reason: 'because',
  })
  expect(parseVerdict('no block at all')).toBeNull()
  expect(parseVerdict(`${block('passed')}\n${block('changes_requested')}`)).toBeNull()
  expect(parseVerdict('```score-verdict\n{not json}\n```')).toBeNull()
  expect(parseVerdict('```score-verdict\n{"verdict":"maybe","reason":"x"}\n```')).toBeNull()
  expect(parseVerdict(block('passed', 'x'.repeat(501)))).toBeNull()
  // An extra, unterminated opening marker is a second block.
  expect(parseVerdict(`${block('passed')}\n\`\`\`score-verdict\n{"verdict":"passed"`)).toBeNull()
})

test('verdicts: a second block beyond the output cap still voids the first', () => {
  const reply = `${block('passed')}\n${'x'.repeat(WORKFLOW_LIMITS.outputBytes + 100)}\n${block('changes_requested')}`
  const facts = resultFacts(reply)
  expect(facts.verdict).toBeNull()
  expect(facts.truncated).toBe(true)
  // What the stored (cut) output shows would have looked like a single valid block.
  expect(parseVerdict(facts.output)?.verdict).toBe('passed')
})

test('verdicts: a block crossing the truncation boundary is parsed from the complete reply', () => {
  const pad = 'y'.repeat(WORKFLOW_LIMITS.outputBytes - 20)
  const facts = resultFacts(`${pad}\n${block('passed')}\nthe end`)
  expect(facts.truncated).toBe(true)
  expect(facts.verdict).toMatchObject({
    verdict: 'passed',
    source: 'runtime',
    outputTruncated: true,
  })
  // The stored output is cut inside the block, so it alone could never have produced the verdict.
  expect(parseVerdict(facts.output)).toBeNull()
})

test('the stored output is cut on a code-point boundary and says so', () => {
  const cut = cutBytes('é'.repeat(10), 5)
  expect(cut).toEqual({ text: 'éé', truncated: true })
})

test('complete-reply facts reach the executor through the run record, and a failed run keeps no verdict path', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  const reply = `${'z'.repeat(20_000)}\n${block('changes_requested', 'needs work')}`
  await endRun(h, runIdOf(h, id, 'a')!, 'completed', reply)
  await h.until(done(id))
  const a = node(h, id, 'a')
  expect(a.verdict).toMatchObject({ verdict: 'changes_requested', reason: 'needs work' })
  // The run record is cut at 8 KiB by ingest; the node keeps up to 32 KiB.
  expect(a.output!.length).toBeGreaterThan(8192)
  expect(a.outputTruncated).toBe(false)
})

test('the fake adapter records complete-reply facts like the live follower: a long reply keeps its verdict', async () => {
  h = await wfHarness({ reply: replies({ a: `${'q'.repeat(9000)}\n${block('passed')}` }) })
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(done(id))
  expect(node(h, id, 'a').verdict?.verdict).toBe('passed')
}, 60_000)

test('without complete-reply facts a run record that may have been cut gives no verdict', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  const runId = runIdOf(h, id, 'a')!
  // A terminal write that bypasses the live follower's fact recording (the run record is cut at 8 KiB).
  const { completeRunMessage } = await import('../../src/domain/message-runs.ts')
  const { runDraft } = await import('../../src/hermes/live/translate.ts')
  const output = `${'q'.repeat(8191 - 80)}${block('passed')}`.slice(0, 8192)
  await h.ingest.submit({
    source: 'test',
    identity: `end:${runId}`,
    apply: ({ sqlite, now }) => {
      sqlite
        .prepare(
          "UPDATE runs SET status = 'completed', ended_at = ?, output = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, output, now, runId)
      return [
        runDraft(sqlite, runId),
        ...completeRunMessage(sqlite, runId, now, { output, status: 'completed' }),
      ]
    },
  })
  await h.until(done(id))
  expect(node(h, id, 'a').verdict).toBeNull()
  expect(node(h, id, 'a').outputTruncated).toBe(true)
})

// ----------------------------------------------------------------------------------------------- payload and bounds

test('the gate shows the exact dispatched text and its hash equals the approved hash', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: 'Write about {{inputs.topic}} — naïve café 日本語' }), end()],
      [edge('a', 'done')],
      [{ name: 'topic', label: 'Topic', required: true, maxChars: 200 }],
    ),
    { gatePolicy: 'every-step', inputs: { topic: 'the <<<release>>> notes' } },
  )
  await h.until(() => node(h!, id, 'a').state === 'gate_open')
  const gate = run(h, id).assignmentGates[0]!
  const step = run(h, id).steps[0]!
  expect(step.instruction).toBe(gate.payload.instruction)
  expect(gate.payload.instruction).toContain('naïve café 日本語')
  expect(gate.payload.instruction).toContain('‹‹‹release›››')
  await decide(h, id, 'a', 'approve')
  await h.until(done(id))
  const attempt = h.rows<{ input: string }>(
    'SELECT input FROM orc_attempts WHERE step_id = ?',
    step.id,
  )[0]!
  expect(attempt.input).toBe(gate.payload.instruction)
  expect(h.rows('SELECT payload_hash FROM orc_steps WHERE id = ?', step.id)).toEqual([
    { payload_hash: sha(attempt.input) },
  ])
})

test('multibyte text is measured in bytes: it fits at the limit and fails one byte over, before any gate', async () => {
  h = await wfHarness()
  const header = 'You are doing one step'.length
  void header
  // Characters of 3 bytes: the instruction is within 32 KiB but the rendered payload (wrapper included) is not.
  const instruction = '日'.repeat(Math.floor((WORKFLOW_LIMITS.payloadBytes - 800) / 3))
  const fits = await start(h, definition([agent('a', { instruction }), end()], [edge('a', 'done')]))
  await h.until(done(fits))
  const tooBig = await start(
    h,
    definition(
      [agent('a', { instruction: instruction + '日'.repeat(200) }), end()],
      [edge('a', 'done')],
    ),
    { gatePolicy: 'every-step' },
  )
  await h.until(
    () => node(h!, tooBig, 'a').state === 'failed' || run(h!, tooBig).status === 'failed',
  )
  expect(node(h, tooBig, 'a').reason).toContain('payload_too_large')
  // Refused before the assignment was frozen: no step, no gate.
  expect(run(h, tooBig).steps).toHaveLength(0)
  expect(run(h, tooBig).assignmentGates).toHaveLength(0)
})

test('quoting expansion counts: three angle brackets become nine bytes in the rendered payload', async () => {
  h = await wfHarness()
  const input = '<<<x'.repeat(900)
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '{{inputs.t}}{{inputs.t}}{{inputs.t}}{{inputs.t}}' }), end()],
      [edge('a', 'done')],
      [{ name: 't', label: 'T', required: true, maxChars: 4096 }],
    ),
    { inputs: { t: input } },
  )
  // 4 × 9,000 bytes of neutralised text is over 32 KiB although the raw input is 3.6 KB.
  await h.until(() => run(h!, id).status === 'failed')
  expect(node(h, id, 'a').reason).toContain('payload_too_large')
})

test('template syntax: defaults, escapes and the references a definition may use', () => {
  const { parts, errors } = parseTemplate(
    'A {{inputs.x|default:"say \\"hi\\""}} B {{nodes.n1.verdict}} {{ nodes.n2 }}',
  )
  expect(errors).toEqual([])
  expect(parts).toEqual([
    'A ',
    { kind: 'input', name: 'x', fallback: 'say "hi"' },
    ' B ',
    { kind: 'node', id: 'n1', field: 'verdict', fallback: null },
    ' ',
    { kind: 'node', id: 'n2', field: 'output', fallback: null },
  ])
  expect(parseTemplate('{{ whatever }}').errors).toHaveLength(1)
  expect(parseTemplate('{{inputs.x.output}}').errors).toHaveLength(1)
  expect(validateDefinition(definition([agent('a'), end()], [edge('a', 'done')])).ok).toBe(true)
})

// ------------------------------------------------------------------ names people choose are not inherited properties

test('S2-010: an input named constructor starts when omitted, and is read from the run when given', async () => {
  h = await wfHarness()
  const def = definition(
    [agent('a', { instruction: 'Note: {{inputs.constructor|default:"none"}}' }), end()],
    [edge('a', 'done')],
    [{ name: 'constructor', label: 'Constructor', required: false, maxChars: 20 }],
  )
  const omitted = await start(h, def, { gatePolicy: 'every-step', inputs: {} })
  await h.until(() => node(h!, omitted, 'a').state === 'gate_open')
  expect(run(h, omitted).assignmentGates[0]!.payload.instruction).toContain('none')
  const empty = await start(h, def, { gatePolicy: 'every-step', inputs: { constructor: '' } })
  await h.until(() => node(h!, empty, 'a').state === 'gate_open')
  expect(run(h, empty).assignmentGates[0]!.payload.instruction).toContain('none')
  const given = await start(h, def, { gatePolicy: 'every-step', inputs: { constructor: 'hello' } })
  await h.until(() => node(h!, given, 'a').state === 'gate_open')
  expect(run(h, given).assignmentGates[0]!.payload.instruction).toContain('hello')
})
