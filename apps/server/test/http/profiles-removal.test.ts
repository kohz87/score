import { expect, test, vi } from 'vitest'
import { AgentOperationSchema, AgentPreviewSchema, type AgentStyle } from '@score/contract'
import {
  createProfile,
  input,
  mutateProfiles,
  profilesTestSuite,
  waitForFinished,
  type ProfilesTestState,
} from './profiles-helpers.ts'

let env: ProfilesTestState['env']
let app: ProfilesTestState['app']
let port: ProfilesTestState['port']
let cookie: string
profilesTestSuite(
  (state) => {
    env = state.env
    app = state.app
    port = state.port
    cookie = state.cookie
  },
  () => ({ env, app, port }),
)
function mutate(
  url: string,
  payload: object,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
  extra: Record<string, string> = {},
) {
  return mutateProfiles({ app, cookie }, url, payload, method, extra)
}
async function create(body: Omit<typeof input, 'style'> & { style: AgentStyle } = input) {
  return createProfile({ app, cookie }, body)
}
async function finished(id: string) {
  return waitForFinished({ app, cookie }, id)
}

test('a removed agent’s name can be reused with a confirm: new incarnation, no inherited pause (2.0.8)', async () => {
  const first = await create()
  await finished(first.id)
  const oldIncarnation = (await app.inject('/api/agents/helper')).json().lifecycle.incarnationId
  // A pause recorded before the removal (the owner paused a half-made agent on live).
  expect((await mutate('/api/agents/helper/pause', {})).statusCode).toBe(200)
  const del = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })).json(),
  )
  const gone = await mutate(
    '/api/agents/helper',
    { typedName: 'helper', previewHash: del.hash },
    'DELETE',
  )
  expect((await finished(gone.json().id)).state).toBe('completed')
  expect(
    env.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM agent_pauses WHERE agent_id = ?')
      .get('helper'),
  ).toEqual({ n: 0 })

  const body = {
    ...input,
    name: 'Helper two',
    role: 'Reviews docs',
    style: { color: '#6B4EFF', shape: 'star' as const },
  }
  const preview = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'create', ...body })).json(),
  )
  expect(preview.reusesName).toBe(true)
  const refused = await mutate('/api/agents', { ...body, previewHash: preview.hash })
  expect(refused.statusCode).toBe(400)
  expect(refused.json().error.message).toMatch(/Confirm reusing the name/)
  const again = await mutate('/api/agents', {
    ...body,
    previewHash: preview.hash,
    confirmReuse: true,
  })
  expect(again.statusCode).toBe(202)
  const op = AgentOperationSchema.parse(again.json())
  expect(op.incarnationId).not.toBe(oldIncarnation)
  expect((await finished(op.id)).state).toBe('completed')
  const agent = (await app.inject('/api/agents/helper')).json()
  expect(agent).toMatchObject({
    name: 'Helper two',
    role: 'Reviews docs',
    style: { color: '#6B4EFF', shape: 'star' },
    lifecycle: { state: 'ready', incarnationId: op.incarnationId },
  })
  expect(agent.status).not.toBe('paused')
})

test('a pause left from before 2.0.8 is cleared when the name is reused', async () => {
  const first = await create()
  await finished(first.id)
  const del = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })).json(),
  )
  const gone = await mutate(
    '/api/agents/helper',
    { typedName: 'helper', previewHash: del.hash },
    'DELETE',
  )
  await finished(gone.json().id)
  env.db.sqlite
    .prepare('INSERT INTO agent_pauses (agent_id, paused_at) VALUES (?, ?)')
    .run('helper', new Date().toISOString())
  const preview = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'create', ...input })).json(),
  )
  const again = await mutate('/api/agents', {
    ...input,
    previewHash: preview.hash,
    confirmReuse: true,
  })
  await finished(again.json().id)
  expect((await app.inject('/api/agents/helper')).json().status).not.toBe('paused')
})

test('a reuse confirm can’t ride on a stale preview (2.0.8)', async () => {
  const first = await create()
  await finished(first.id)
  const before = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'create', ...input })).json(),
  )
  const del = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })).json(),
  )
  const gone = await mutate(
    '/api/agents/helper',
    { typedName: 'helper', previewHash: del.hash },
    'DELETE',
  )
  await finished(gone.json().id)
  const stale = await mutate('/api/agents', {
    ...input,
    previewHash: before.hash,
    confirmReuse: true,
  })
  expect(stale.statusCode).toBe(409)
})

// 3.2.2: removing an agent whose setup stopped abandons that setup first.
test('a setup that stopped before Hermes made the profile can be removed: only the name is retired', async () => {
  const { HttpError } = await import('../../src/errors.ts')
  const real = port.profileStep.bind(port)
  let refuse = true
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'create_profile' && refuse) throw new HttpError(409, 'conflict', 'Hermes refused.')
    return real(step, context)
  })
  const added = await create()
  expect(await finished(added.id)).toMatchObject({
    state: 'needs_attention',
    nextStep: 'create_profile',
  })
  refuse = false
  const preview = (
    await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
  ).json()
  expect(preview.blockers).toEqual([])
  expect(preview.exportPath).toBeNull()
  expect(preview.effects.join(' ')).toMatch(/never made the profile/)
  const steps: string[] = []
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    steps.push(step)
    return real(step, context)
  })
  const removed = await mutate(
    '/api/agents/helper',
    { typedName: 'helper', previewHash: preview.hash },
    'DELETE',
  )
  expect(removed.statusCode).toBe(202)
  expect((await finished(removed.json().id)).state).toBe('completed')
  // Nothing was exported or deleted in Hermes.
  expect(steps.filter((step) => step !== 'retire')).toEqual([])
  expect((await app.inject('/api/agents/helper')).json()).toMatchObject({
    lifecycle: { state: 'removed' },
  })
  expect((await finished(added.id)).state).toBe('completed')
})

test('a setup that stopped after Hermes made the profile is removed like any agent', async () => {
  const { HttpError } = await import('../../src/errors.ts')
  const real = port.profileStep.bind(port)
  let fail = true
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'permissions' && fail)
      throw new HttpError(409, 'conflict', 'Team permission readback did not match.')
    return real(step, context)
  })
  const added = await create()
  expect(await finished(added.id)).toMatchObject({
    state: 'needs_attention',
    nextStep: 'permissions',
  })
  fail = false
  const preview = (
    await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
  ).json()
  expect(preview.blockers).toEqual([])
  expect(preview.exportPath).toMatch(/\/profile-backups\/helper-/)
  expect(preview.effects.join(' ')).toMatch(/abandoned first/)
  const removed = await mutate(
    '/api/agents/helper',
    { typedName: 'helper', previewHash: preview.hash },
    'DELETE',
  )
  expect(removed.statusCode).toBe(202)
  expect((await finished(removed.json().id)).state).toBe('completed')
  expect((await app.inject('/api/agents/helper')).json()).toMatchObject({
    lifecycle: { state: 'removed' },
  })
})

test('a setup that is still running is never abandoned by a removal', async () => {
  const real = port.profileStep.bind(port)
  let release: () => void = () => {}
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'create_profile') await new Promise<void>((done) => (release = done))
    return real(step, context)
  })
  await create()
  const preview = (
    await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
  ).json()
  expect(preview.blockers.join(' ')).toMatch(/An operation already holds this agent/)
  release()
})

test('a retry still in flight when the setup is abandoned never brings it back (3.2.2)', async () => {
  const { HttpError } = await import('../../src/errors.ts')
  const real = port.profileStep.bind(port)
  let fail = true
  let hold: (() => void) | null = null
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'permissions' && fail)
      throw new HttpError(409, 'conflict', 'Team permission readback did not match.')
    if (step === 'permissions' && !fail) await new Promise<void>((done) => (hold = done))
    return real(step, context)
  })
  const added = await create()
  expect(await finished(added.id)).toMatchObject({ state: 'needs_attention' })
  fail = false
  // The retry starts and waits inside its step.
  const retried = await mutate(`/api/agents/operations/${added.id}/retry`, {}, 'POST', {
    'idempotency-key': 'retry-then-remove',
  })
  expect(retried.statusCode).toBe(200)
  await vi.waitFor(() => expect(hold).not.toBeNull())
  // While it waits, the op is running again, so the removal is refused rather than racing it.
  const preview = (
    await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
  ).json()
  expect(preview.blockers.join(' ')).toMatch(/An operation already holds this agent/)
  hold!()
  await vi.waitFor(async () => expect((await finished(added.id)).state).toBe('completed'), {
    timeout: 5000,
  })
})

test('an interrupted setup step is confirmed, not abandoned (3.2.2)', async () => {
  const added = await create()
  await finished(added.id)
  // Simulate Score losing track of create_profile: the step stays running in a stopped operation.
  env.db.sqlite
    .prepare(
      "UPDATE profile_operations SET state = 'needs_attention', operation = json_set(operation, '$.state', 'needs_attention', '$.steps[0].state', 'running', '$.confirmable', json('true')) WHERE id = ?",
    )
    .run(added.id)
  env.db.sqlite
    .prepare(
      "UPDATE agent_lifecycle SET state = 'needs_attention', operation_id = ? WHERE agent_id = 'helper'",
    )
    .run(added.id)
  const preview = (
    await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
  ).json()
  expect(preview.blockers.join(' ')).toMatch(/An operation already holds this agent/)
})

test('stop-work ends an agent’s queued turns and asks its running ones to stop, so it can be removed (3.7.1)', async () => {
  const added = await create()
  await finished(added.id)
  const now = new Date().toISOString()
  env.db.sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('stuck-run', 'helper', 'score', 'running', ?, ?)",
    )
    .run(now, now)
  env.db.sqlite
    .prepare(
      "INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('busy-room', 'busy-room', 'room', '[\"helper\"]', ?, ?)",
    )
    .run(now, now)
  env.db.sqlite
    .prepare(
      "INSERT INTO messages (id, room_id, author_kind, \"to\", parts, refs, streaming, created_at, updated_at) VALUES ('busy-message', 'busy-room', 'you', '[]', '[]', '[]', 0, ?, ?)",
    )
    .run(now, now)
  env.db.sqlite
    .prepare(
      "INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at) VALUES ('reply', 'busy-room', 'helper', 'busy-message', 0, 'queued-turn', 'busy-message', 'Example', '[\"helper\"]', ?)",
    )
    .run(now)
  const before = (await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })).json()
  expect(before.pendingWork).toMatchObject({ activeRuns: 1, queuedTurns: 1 })
  const stop = vi.spyOn(port, 'stopRun').mockImplementation(async ({ runId }) => {
    env.db.sqlite.prepare("UPDATE runs SET status = 'cancelled' WHERE id = ?").run(runId)
  })
  const stopped = await mutate('/api/agents/helper/stop-work', {}, 'POST', {
    'idempotency-key': 'stop-helper',
  })
  expect(stopped.statusCode).toBe(200)
  expect(stop).toHaveBeenCalledWith({ agentId: 'helper', runId: 'stuck-run' })
  const after = (await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })).json()
  expect(after.pendingWork).toMatchObject({ activeRuns: 0, queuedTurns: 0 })
  expect(after.blockers).toEqual([])
  // The queued turn ended with a notice in its room, not silently.
  const notice = env.db.sqlite.prepare("SELECT parts FROM messages WHERE id = 'reply'").get() as
    { parts: string } | undefined
  expect(notice?.parts).toContain('stopped before it started')
})

test('a delete Hermes didn’t finish can be retried on the same folder, then removes the agent (3.7.3)', async () => {
  const { HttpError } = await import('../../src/errors.ts')
  const added = await create()
  await finished(added.id)
  const real = port.profileStep.bind(port)
  let refuse = true
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'delete_profile' && refuse)
      throw new HttpError(409, 'conflict', 'The CLI refused or didn’t confirm this step.')
    return real(step, context)
  })
  const preview = (
    await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
  ).json()
  const removed = await mutate(
    '/api/agents/helper',
    { typedName: 'helper', previewHash: preview.hash },
    'DELETE',
  )
  const opId = removed.json().id as string
  const stuck = await finished(opId)
  expect(stuck).toMatchObject({ state: 'needs_attention', nextStep: 'delete_profile' })
  // Reading it (the panel polls) finds the same folder still there: Retry is offered.
  const read = (
    await app.inject({
      url: `/api/agents/operations/${opId}`,
      headers: { 'x-score-client': 'web', cookie },
    })
  ).json()
  expect(read.retryable).toBe(true)
  refuse = false
  const retried = await mutate(`/api/agents/operations/${opId}/retry`, {}, 'POST', {
    'idempotency-key': 'retry-delete',
  })
  expect(retried.statusCode).toBe(200)
  await vi.waitFor(async () => expect((await finished(opId)).state).toBe('completed'), {
    timeout: 5000,
  })
  expect((await app.inject('/api/agents/helper')).json()).toMatchObject({
    lifecycle: { state: 'removed' },
  })
})
