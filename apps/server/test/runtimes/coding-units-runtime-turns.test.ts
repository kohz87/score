import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  addAgent,
  afterEachHarness,
  app,
  backend,
  beforeEachHarness,
  boot,
  cliCalls,
  coding,
  db,
  errors,
  fake,
  finished,
  home,
  journalKinds,
  launches,
  makeRoom,
  namespace,
  processLaunches,
  replies,
  request,
  roomId,
  runs,
  runtimeDir,
  say,
  setEnv,
  textOf,
} from './coding-units-runtime-helpers.ts'

beforeEach(beforeEachHarness)
afterEach(afterEachHarness)

// ---- the normal turn -------------------------------------------------------------------------------------------------

test('a Chat turn runs as a supervised unit end to end: journal phases, receipts outside the home, collection', async () => {
  expect(backend.status.kind).toBe('unit')
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] write hello')
  await finished()
  expect(runs()[0]!.error, JSON.stringify(errors.map(String))).toBeNull()
  expect(runs()[0]).toMatchObject({ status: 'completed' })
  expect(textOf(replies()[0])).toContain('Created hello.txt and changed it.')
  // The unit backend launched it: no process-group spawn.
  expect(processLaunches).toBe(0)
  expect(cliCalls()).toHaveLength(1)
  const [launch] = launches()
  expect(launch).toMatchObject({
    backend: 'unit',
    agent_id: 'coder',
    runtime: 'claude-code',
    phase: 'settled',
    may_have_executed: 1,
    revoked: 0,
    held: 0,
    eligibility: 'eligible',
    disposition: 'committed',
  })
  // The exact unit name is stored, in the lead's shape, and the journal's records carry the whole story.
  expect(launch!.unit).toMatch(/^score-abcdef01-c-[0-9a-f]{32}\.service$/)
  expect(launch!.invocation_id).toMatch(/^[0-9a-f]{32}$/)
  expect(journalKinds(launch!.launch_id)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'released-seen',
    'ended',
    'settled',
  ])
  // Receipts live beside the journal, outside the home; the spec (with its token) is gone.
  expect(launch!.receipt_dir!.startsWith(namespace)).toBe(true)
  expect(launch!.receipt_dir!.startsWith(home)).toBe(false)
  expect(readdirSync(launch!.receipt_dir!).sort()).toEqual([
    'acked.json',
    'ended.json',
    'identity.json',
    'released.json',
    'routing.json',
  ])
  expect(existsSync(join(runtimeDir, 'score', 'abcdef01', 'launches', launch!.launch_id))).toBe(
    false,
  )
  // Collected: the unit is gone from the manager.
  expect(fake.units.size).toBe(0)
  expect(errors).toEqual([])
})

test('the CLI environment is built by the supervisor from the spec: Score’s own variables never reach it', async () => {
  setEnv('SCORE_SECRET_SENTINEL', 'x')
  setEnv('ANTHROPIC_API_KEY', 'sk-test')
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  await finished()
  const env = cliCalls()[0]!.env
  expect(env).not.toContain('SCORE_SECRET_SENTINEL')
  expect(env).not.toContain('ANTHROPIC_API_KEY')
  expect(env).toContain('PATH')
})

// ---- acceptance matrix and hand-offs -----------------------------------------------------------------------------------

test('Claude Code without an explicit success is no result, even with text and a clean exit', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:nosuccess] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(runs()[0]!.error).toContain('without a result Score can use')
  expect(launches()[0]).toMatchObject({ phase: 'settled' })
  expect(launches()[0]!.eligibility).toContain('explicit success')
})

test('Codex: hand-offs read only the final validated agent_message, never earlier commentary', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:commentary] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  const handoffs = db.sqlite
    .prepare("SELECT agent_id FROM message_runs WHERE from_agent_id = 'cx'")
    .all()
  expect(handoffs).toEqual([])
  // The visible reply is still the whole conversation; only the authority is narrower.
  expect(textOf(replies()[0])).toContain('Done. Nothing else is needed.')
})

test('Codex: a malformed agent_message invalidates the turn: no result, no hand-off', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:malformed] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(
    db.sqlite.prepare("SELECT agent_id FROM message_runs WHERE from_agent_id = 'cx'").all(),
  ).toEqual([])
})

test('Antigravity: SUCCESS with a response completes on the unit backend', async () => {
  setEnv('SCORE_CODING_VERIFIED_ANTIGRAVITY', 'read-only')
  await addAgent({
    id: 'agy1',
    name: 'Agy',
    runtime: 'antigravity',
    permission: 'read-only',
    acknowledgeReads: true,
  })
  await makeRoom()
  await say('@agy1 [fixture:basic] go')
  await finished()
  expect(runs()[0]!.status).toBe('completed')
  expect(launches()[0]).toMatchObject({ phase: 'settled', runtime: 'antigravity' })
})

test('the eligible reply still hands off to another agent', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:handoff] build it')
  await finished()
  const handoff = db.sqlite
    .prepare("SELECT agent_id, from_agent_id, hop FROM message_runs WHERE from_agent_id = 'coder'")
    .all()
  expect(handoff).toEqual([{ agent_id: 'reviewer', from_agent_id: 'coder', hop: 1 }])
})

test('a refused resume starts one fresh launch; the first is settled as retried', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stale] one')
  await finished()
  await say('@coder [fixture:stale] two')
  await finished(2)
  expect(runs()[1]).toMatchObject({ status: 'completed' })
  const all = launches()
  expect(all).toHaveLength(3)
  expect(all.every((l) => l.phase === 'settled')).toBe(true)
  expect(all.map((l) => l.disposition)).toContain('retried')
})

test('FV #3: a resume refusal behind a record Score could not read is not retried: one launch, the first attempt’s loss stands', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:stalelossy] one')
  await finished()
  await say('@coder [fixture:stalelossy] two')
  await finished(2)
  // The rejected record could have been work the refusal text hides: no second launch, no completed result.
  expect(launches()).toHaveLength(2)
  expect(runs()[1]).toMatchObject({ status: 'failed' })
  expect(launches().map((l) => l.disposition)).not.toContain('retried')
})

// ---- launch rate and pause -------------------------------------------------------------------------------------------

test('Score keeps its own launch backoff: too many units in a minute are refused with a sentence', async () => {
  await coding.close()
  await app.close()
  await boot({ unit: { launchesPerMinute: 1 } })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] one')
  await finished()
  await say('@coder [fixture:basic] two')
  await finished(2)
  expect(runs()[0]!.status).toBe('completed')
  expect(runs()[1]!.status).toBe('failed')
  expect(runs()[1]!.error).toContain('too quickly')
})

test('a fence pauses supervised launching with a sentence the person can act on', async () => {
  await coding.close()
  await app.close()
  await boot({ blocked: () => 'Score is waiting for you to review the coding journal.' })
  await addAgent()
  await makeRoom()
  const response = await request('POST', `/api/rooms/${roomId}/messages`, {
    text: '@coder [fixture:basic] go',
  })
  expect(response.statusCode).toBe(200)
  await vi.waitFor(() => expect(JSON.stringify(replies())).toMatch(/review the coding journal/), {
    timeout: 10_000,
  })
  expect(cliCalls()).toHaveLength(0)
})

test('settled follows the terminal commit: a result that cannot be saved yet is delivered later, and only then settled', async () => {
  await coding.close()
  await app.close()
  let failures = 0
  await boot({
    ingestWrap: (real) => ({
      submit: (observation) => {
        // The first six attempts at the terminal result fail (more than the foreground budget of five).
        if (observation.identity.endsWith(':terminal') && failures++ < 6)
          return Promise.reject(new Error('database is locked'))
        return real.submit(observation)
      },
    }),
  })
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:basic] go')
  // The run has ended (proof obtained) but its result is still waiting: the launch is `ended`, not `settled`.
  await vi.waitFor(() => expect(launches()[0]?.phase).toBe('ended'), { timeout: 15_000 })
  expect(runs()[0]!.status).toBe('running')
  expect(db.sqlite.prepare('SELECT run_id FROM coding_pending_terminals').all()).toHaveLength(1)
  await vi.waitFor(() => expect(launches()[0]?.phase).toBe('settled'), { timeout: 15_000 })
  expect(runs()[0]!.status).toBe('completed')
  expect(db.sqlite.prepare('SELECT run_id FROM coding_pending_terminals').all()).toEqual([])
})

test('#1 (re-review 2): a malformed terminal record after a success takes the authority away', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:lateterminal] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(launches()[0]!.eligibility).toContain('could not validate')
})

test('FT #1: a failed terminal followed by a success never completes the run (codex)', async () => {
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@cx [fixture:failedthenok] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(launches()[0]!.eligibility).not.toBe('eligible')
})

test('FT #1: an error result followed by a success never completes the run (claude)', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:failedthenok] go')
  await finished()
  expect(runs()[0]!.status).toBe('failed')
  expect(launches()[0]!.eligibility).not.toBe('eligible')
})
