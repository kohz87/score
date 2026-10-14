import { afterEach, describe, expect, test, vi } from 'vitest'
import { recordRunResult } from '../../src/domain/workflows/verdict.ts'
import { addCodingAgent, startWorkflow, wfRunOf } from '../helpers/wf-coding.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { agent, definition, edge, end } from './wf-harness.ts'

// 7.7c-1 #4 (design §3, §5): a coding step's verdict is read from the raw eligible reply (never the 32 KiB copy, never a
// prefix), joined by (attempt, generation); an over-limit or missing answer fails the node; the copies a workflow keeps
// are charged to the coding partition.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })
let h: WorkerHarness
afterEach(async () => {
  await h?.close()
  h = undefined as never
})

const rows = (sql: string, ...args: (string | number)[]) =>
  h.rows<Record<string, unknown>>(sql, ...args)
const one = (fixture: string, over: Parameters<typeof agent>[1] = {}) =>
  definition(
    [agent('a', { agentId: 'cc', instruction: `[fixture:${fixture}] go`, ...over }), end()],
    [edge('a', 'done')],
  )
const done = (id: string) => h.until(() => ['succeeded', 'failed'].includes(wfRunOf(h, id).status))
const node = (id: string, nodeId: string) =>
  wfRunOf(h, id).nodeStates.find((n) => n.nodeId === nodeId)!
async function boot(options: Parameters<typeof workerHarness>[0] = {}): Promise<void> {
  h = await workerHarness(options)
  addCodingAgent(h, 'cc', 'claude-code')
  addCodingAgent(h, 'cx', 'codex', 'read-only')
}

describe('verdicts of coding steps', () => {
  test('a workflow with a Claude Code and a Codex step completes, each verdict from the CLI’s own final answer', async () => {
    await boot()
    const def = definition(
      [
        agent('a', { agentId: 'cc', instruction: '[fixture:verdict] review' }),
        agent('b', { agentId: 'cx', instruction: '[fixture:verdict] review again' }),
        end(),
      ],
      [edge('a', 'b'), edge('b', 'done')],
    )
    const id = await startWorkflow(h, def)
    await done(id)
    expect(wfRunOf(h, id)).toMatchObject({ status: 'succeeded', graphOutcome: 'reached_end' })
    expect(node(id, 'a').verdict).toMatchObject({ verdict: 'passed', reason: 'All checks pass' })
    expect(node(id, 'b').verdict).toMatchObject({
      verdict: 'changes_requested',
      reason: 'One test is missing',
    })
    expect(node(id, 'a').output).toContain('Reviewed the change.')
    expect(h.cliCalls().map((call) => call.runtime)).toEqual(['claude-code', 'codex'])
    // Each result is keyed by the dispatch generation that ran.
    expect(
      rows('SELECT generation FROM wf_results ORDER BY attempt_id').map((r) => r['generation']),
    ).toEqual([1, 1])
  })

  test('a verdict after the first 32 KiB is still read; the stored output is cut and says so', async () => {
    await boot()
    const id = await startWorkflow(h, one('verdictlate'))
    await done(id)
    const a = node(id, 'a')
    expect(a.verdict).toMatchObject({
      verdict: 'changes_requested',
      reason: 'Needs another pass',
      outputTruncated: true,
    })
    expect(a.outputTruncated).toBe(true)
    expect(a.output).not.toContain('score-verdict')
  })

  test('two verdict blocks more than 32 KiB apart are no verdict: the whole reply decides, never a prefix', async () => {
    await boot()
    const id = await startWorkflow(h, one('verdicttwice'))
    await done(id)
    expect(wfRunOf(h, id).status).toBe('succeeded')
    expect(node(id, 'a').verdict).toBeNull()
    expect(node(id, 'a').outputTruncated).toBe(true)
  })

  test('an answer over the verdict input limit fails the node, for either CLI', async () => {
    await boot()
    const first = await startWorkflow(h, one('toolong'))
    await done(first)
    expect(wfRunOf(h, first).status).toBe('failed')
    expect(node(first, 'a')).toMatchObject({
      state: 'failed',
      verdict: null,
      reason: 'answer too long to read a verdict',
    })
    const codex = await startWorkflow(
      h,
      definition(
        [
          agent('a', { agentId: 'cx', instruction: '[fixture:toolong] go', onFailure: 'fail_run' }),
          end(),
        ],
        [edge('a', 'done')],
      ),
    )
    await done(codex)
    expect(node(codex, 'a')).toMatchObject({
      state: 'failed',
      reason: 'answer too long to read a verdict',
    })
  })

  test('no eligible reply means no result row and no verdict: the node fails “no final answer”', async () => {
    await boot()
    // The CLI ended without an explicit success: there is nothing to read a verdict from.
    const failed = await startWorkflow(h, one('nosuccess'))
    await done(failed)
    expect(rows('SELECT 1 FROM wf_results')).toEqual([])
    expect(node(failed, 'a')).toMatchObject({ state: 'failed', verdict: null })
    // A completed step whose result row is missing is the same: the node never succeeds without its facts.
    h.db.sqlite.exec(
      'CREATE TRIGGER lose_result AFTER INSERT ON wf_results BEGIN DELETE FROM wf_results WHERE rowid = NEW.rowid; END',
    )
    const lost = await startWorkflow(h, one('verdict'))
    await done(lost)
    expect(wfRunOf(h, lost).status).toBe('failed')
    expect(node(lost, 'a')).toMatchObject({
      state: 'failed',
      verdict: null,
      reason: 'no final answer',
    })
  })

  test('the result joins by (attempt, generation): a late result of an earlier generation can’t replace the current one', async () => {
    // Generation 1 is held back before it launches; generation 2 runs and its answer is the node’s.
    await boot({
      orchestrator: {
        releaseChecks: {
          policy: (_sqlite, subject) => (subject.generation === 1 ? 'hold' : undefined),
        },
      },
    })
    const id = await startWorkflow(h, one('verdict'))
    await done(id)
    expect(node(id, 'a').verdict).toMatchObject({ verdict: 'passed' })
    const attempt = rows("SELECT id FROM orc_attempts WHERE kind = 'step'")[0]!['id'] as string
    expect(rows('SELECT generation FROM wf_results WHERE attempt_id = ?', attempt)).toEqual([
      { generation: 2 },
    ])
    // A run of generation 1 reporting late (it never launched, but suppose its record arrives) is another row, not a replacement.
    const g1 = rows(
      'SELECT message_id FROM orc_generations WHERE attempt_id = ? AND generation = 1',
      attempt,
    )[0]!
    h.db.sqlite
      .prepare(
        "INSERT INTO runs (id, profile, origin, score_turn_id, status, started_at, updated_at, runtime) VALUES ('run-g1', 'cc', 'score', 'turn-g1', 'completed', ?, ?, 'claude-code')",
      )
      .run(new Date().toISOString(), new Date().toISOString())
    h.db.sqlite
      .prepare('UPDATE message_runs SET run_id = ? WHERE message_id = ?')
      .run('run-g1', g1['message_id'] as string)
    h.db.tx((sqlite) =>
      recordRunResult(
        sqlite,
        'run-g1',
        'Late.\n```score-verdict\n{"verdict":"changes_requested","reason":"stale"}\n```',
        new Date().toISOString(),
      ),
    )
    const stored = rows(
      'SELECT generation, verdict FROM wf_results WHERE attempt_id = ? ORDER BY generation',
      attempt,
    )
    expect(stored.map((r) => r['generation'])).toEqual([1, 2])
    expect(JSON.parse(stored[1]!['verdict'] as string).verdict).toBe('passed')
  })
})

describe('what a workflow keeps of a coding step', () => {
  test('the result row and the node’s own copy are charged to the coding partition', async () => {
    await boot()
    const id = await startWorkflow(h, one('verdictlate'))
    await done(id)
    const orch = rows(
      'SELECT coding_stored_bytes AS c, coding_reserve_bytes AS r FROM orchestrations WHERE id = ?',
      id,
    )[0]!
    const result = rows('SELECT output, verdict FROM wf_results')[0]!
    const bytes = (text: unknown) => Buffer.byteLength(String(text ?? ''))
    const step = rows('SELECT result FROM orc_steps')[0]!
    const attempt = rows("SELECT input FROM orc_attempts WHERE kind = 'step'")[0]!
    const reply = rows('SELECT reply FROM coding_run_results')[0]!
    const run = rows('SELECT output FROM runs')[0]!
    const expected =
      bytes(attempt['input']) +
      bytes(reply['reply']) +
      2 * bytes(step['result']) +
      bytes(run['output']) +
      // the two workflow copies: the result row (with its verdict record) and the node’s output
      bytes(result['output']) +
      bytes(result['verdict']) +
      bytes(result['output'])
    // Everything a run keeps of the step is charged once; the run's own 8 KB output record is the only other part.
    expect(Number(orch['c'])).toBeGreaterThanOrEqual(expected)
    expect(Number(orch['c'])).toBeLessThanOrEqual(expected + 8 * 1024)
    expect(Number(orch['c'])).toBeLessThan(Number(orch['r']))
  })
})
