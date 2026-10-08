import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentOperationSchema, AgentPreviewSchema, type AgentOperation } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { requestRunApproval } from '../../src/domain/approvals.ts'
import { ProfileOperations } from '../../src/domain/profiles.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie: string
const input = {
  id: 'helper',
  name: 'Helper',
  role: 'Builds small changes',
  model: 'fake-model',
  style: { color: '#19C39A', shape: 'triangle' as const },
}
beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  app = buildApp({
    config: loadConfig({ SCORE_HOME: env.home }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function mutate(
  url: string,
  payload: object,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
  extra: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    payload,
    headers: { cookie, 'x-score-client': 'web', ...extra },
  })
}
async function create(body = input) {
  const preview = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'create', ...body })).json(),
  )
  const response = await mutate('/api/agents', {
    ...body,
    previewHash: preview.hash,
    confirmInheritance: true,
  })
  expect(response.statusCode).toBe(202)
  return AgentOperationSchema.parse(response.json())
}
async function finished(id: string) {
  let result: AgentOperation | undefined
  await vi.waitFor(
    async () => {
      result = AgentOperationSchema.parse(
        (await app.inject({ url: `/api/agents/operations/${id}`, headers: { cookie } })).json(),
      )
      expect(result.state).not.toBe('running')
    },
    { timeout: 5000, interval: 25 },
  )
  return result!
}

test('create is observable as Setting up, then verifies every step and preserves display/style through restart', async () => {
  const operation = await create()
  const settingUp = (await app.inject('/api/agents/helper')).json()
  expect(settingUp).toMatchObject({
    lifecycle: { state: 'setting_up' },
    served: false,
    activity: 'Setting up',
  })
  expect(await finished(operation.id)).toMatchObject({ state: 'completed', nextStep: null })
  const ready = (await app.inject('/api/agents/helper')).json()
  expect(ready).toMatchObject({
    name: 'Helper',
    role: input.role,
    style: input.style,
    lifecycle: { state: 'ready' },
    model: { id: input.model },
  })
  expect((await finished(operation.id)).steps.every((step) => step.state === 'completed')).toBe(
    true,
  )
  await app.close()
  port = new FakePort(1, { db: env.db }, false)
  app = buildApp({
    config: loadConfig({ SCORE_HOME: env.home }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
  expect((await app.inject('/api/agents/helper')).json()).toMatchObject({
    name: 'Helper',
    lifecycle: { state: 'ready', incarnationId: operation.incarnationId },
  })
})
test('clone previews inherited names, requires confirmation and applies the team baseline', async () => {
  const body = { ...input, cloneFrom: 'builder' }
  const preview = (await mutate('/api/agents/preview', { kind: 'create', ...body })).json()
  expect(preview.inherited).toMatchObject({
    memories: ['MEMORY.md', 'USER.md'],
    plugins: ['score-bridge'],
    credentialsPresent: ['example-provider'],
  })
  expect((await mutate('/api/agents', { ...body, previewHash: preview.hash })).statusCode).toBe(400)
  const response = await mutate('/api/agents', {
    ...body,
    previewHash: preview.hash,
    confirmInheritance: true,
  })
  expect(response.statusCode).toBe(202)
  expect((await finished(response.json().id)).state).toBe('completed')
  expect(await port.readApprovals('helper')).toEqual({ mode: 'smart', allowlist: [], deny: [] })
})
test('stale preview and existing/default names are refused; receipts replay without creating twice', async () => {
  const preview = (await mutate('/api/agents/preview', { kind: 'create', ...input })).json()
  expect(
    (await mutate('/api/agents', { ...input, role: 'Changed role', previewHash: preview.hash }))
      .statusCode,
  ).toBe(409)
  expect(
    (await mutate('/api/agents/preview', { kind: 'create', ...input, id: 'default' })).json()
      .blockers,
  ).not.toEqual([])
  expect(
    (await mutate('/api/agents/preview', { kind: 'create', ...input, id: 'builder' })).json()
      .blockers,
  ).not.toEqual([])
  const body = { ...input, previewHash: preview.hash }
  const headers = { 'idempotency-key': 'profile-create' }
  const response = await mutate('/api/agents', body, 'POST', headers)
  const repeated = await mutate('/api/agents', body, 'POST', headers)
  expect(repeated.json()).toEqual(response.json())
  expect(env.db.sqlite.prepare('SELECT * FROM profile_operations').all()).toHaveLength(1)
  await finished(response.json().id)
})
test('display name stays Score-owned and description is verified without renaming', async () => {
  const response = await mutate(
    '/api/agents/builder',
    { name: 'Build team', role: 'Works on tests' },
    'PATCH',
  )
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({
    id: 'builder',
    name: 'Build team',
    role: 'Works on tests',
  })
  expect((await app.inject('/api/agents/builder')).json().name).toBe('Build team')
  expect((await port.listAgents()).find((agent) => agent.id === 'builder')?.name).toBe('builder')
  expect((await mutate('/api/agents/builder', { role: '' }, 'PATCH')).statusCode).toBe(400)
})
test('delete requires typed name and a current preview, exports first, retires memberships and preserves history', async () => {
  const added = await create()
  await finished(added.id)
  const room = await mutate('/api/rooms', {
    name: 'helper-room',
    members: ['helper', 'builder'],
    leadAgentId: 'helper',
  })
  expect(room.statusCode).toBe(200)
  const preview = (
    await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
  ).json()
  expect(preview.exportPath).toMatch(/\/profile-backups\/helper-/)
  expect(preview.effects.join(' ')).toMatch(/omits credentials.*not a full undo/)
  expect(
    (
      await mutate(
        '/api/agents/helper',
        { typedName: 'wrong', previewHash: preview.hash },
        'DELETE',
      )
    ).statusCode,
  ).toBe(400)
  const response = await mutate(
    '/api/agents/helper',
    { typedName: 'helper', previewHash: preview.hash },
    'DELETE',
  )
  expect(response.statusCode).toBe(202)
  expect((await finished(response.json().id)).state).toBe('completed')
  expect((await app.inject('/api/agents/helper')).json()).toMatchObject({
    lifecycle: { state: 'removed' },
    activity: 'Removed',
  })
  const retainedRoom = (await app.inject(`/api/rooms/${room.json().id}`)).json().room
  expect(retainedRoom).toMatchObject({ members: ['builder'], leadAgentId: null })
  expect(
    (await mutate('/api/agents/preview', { kind: 'create', ...input })).json().blockers.join(' '),
  ).toMatch(/retired/)
  expect(
    (await mutate('/api/agents/preview', { kind: 'delete', agentId: 'default' }))
      .json()
      .blockers.join(' '),
  ).toMatch(/reserved/)
  expect(
    env.db.sqlite
      .prepare("SELECT count(*) AS count FROM events WHERE type = 'agent.updated'")
      .get()!.count,
  ).toBeGreaterThan(0)
})
test.each(['runs', 'queued', 'approvals', 'assignments'])(
  'delete refuses %s work after freezing admissions',
  async (kind) => {
    const added = await create()
    await finished(added.id)
    const preview = (
      await mutate('/api/agents/preview', { kind: 'delete', agentId: 'helper' })
    ).json()
    const now = new Date().toISOString()
    if (kind === 'runs')
      env.db.sqlite
        .prepare(
          "INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('busy', 'helper', 'score', 'running', ?, ?)",
        )
        .run(now, now)
    if (kind === 'approvals') {
      await env.ingest.submit({
        source: 'fixture',
        identity: 'pending-approval',
        apply: ({ sqlite, now }) =>
          requestRunApproval(
            sqlite,
            {
              profile: 'helper',
              runId: 'external',
              requestId: 'decision',
              command: 'example',
              description: 'Needs a decision',
              choices: ['once', 'deny'],
            },
            now,
          ),
      })
    }
    if (kind === 'queued') {
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
    }
    if (kind === 'assignments')
      env.db.sqlite
        .prepare('INSERT INTO task_projections (id, detail) VALUES (?, ?)')
        .run(
          'assigned',
          JSON.stringify({ assignee: 'helper', reviewer: null, hermesStatus: 'todo' }),
        )
    expect(
      (
        await mutate(
          '/api/agents/helper',
          { typedName: 'helper', previewHash: preview.hash },
          'DELETE',
        )
      ).statusCode,
    ).toBe(409)
    expect((await app.inject('/api/agents/helper')).json().lifecycle.state).toBe('ready')
  },
)
test.each([
  'POST /api/agents/preview',
  'POST /api/agents',
  'PATCH /api/agents/builder',
  'DELETE /api/agents/builder',
])('human guard and CSRF protect %s', async (route) => {
  const [method, url] = route.split(' ')
  expect(
    (
      await app.inject({
        method: method as 'POST',
        url: url!,
        payload: {},
        headers: { 'x-score-client': 'web' },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (await app.inject({ method: method as 'POST', url: url!, payload: {}, headers: { cookie } }))
      .statusCode,
  ).toBe(403)
  expect(env.db.sqlite.prepare('SELECT * FROM profile_operations').all()).toEqual([])
})
test('operation status is paired and lifecycle blocks room admission', async () => {
  const operation = await create()
  expect((await app.inject(`/api/agents/operations/${operation.id}`)).statusCode).toBe(401)
  expect((await mutate('/api/rooms', { name: 'setup-room', members: ['helper'] })).statusCode).toBe(
    400,
  )
  await finished(operation.id)
})
test('a delayed readiness handshake converges through status reads without repeating provisioning writes', async () => {
  const real = port.profileStep.bind(port)
  let available = false
  const spy = vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'verify_ready' && !available) throw new Error('not ready')
    return real(step, context)
  })
  const added = await create()
  expect((await finished(added.id)).state).toBe('needs_attention')
  spy.mockClear()
  available = true
  expect((await finished(added.id)).state).toBe('needs_attention')
  await vi.waitFor(async () => expect((await finished(added.id)).state).toBe('completed'), {
    timeout: 5000,
  })
  expect(spy.mock.calls.every(([step]) => step === 'verify_ready')).toBe(true)
})
test('concurrent create requests hold one durable lock per target', async () => {
  const preview = (await mutate('/api/agents/preview', { kind: 'create', ...input })).json()
  const requests = await Promise.all([
    mutate('/api/agents', { ...input, previewHash: preview.hash }),
    mutate('/api/agents', { ...input, previewHash: preview.hash }),
  ])
  expect(requests.map((response) => response.statusCode).sort()).toEqual([202, 409])
  expect(
    env.db.sqlite.prepare("SELECT id FROM profile_operations WHERE target_name = 'helper'").all(),
  ).toHaveLength(1)
  await finished(requests.find((response) => response.statusCode === 202)!.json().id)
})
test.each([
  'create_profile',
  'preserve_key',
  'configure_key',
  'model',
  'permissions',
  'install_bridge',
  'enable_bridge',
  'verify_ready',
])('recovery continues after the verified %s step without repeating it', async (stepName) => {
  const operations = new ProfileOperations(env.db, env.ingest, port)
  const realStep = port.profileStep.bind(port)
  let stopped: Promise<void> | undefined
  const spy = vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    const result = await realStep(step, context)
    if (step === stepName) stopped = operations.close()
    return result
  })
  const request = { kind: 'create' as const, ...input }
  const preview = await operations.preview(request)
  const operation = await operations.begin(request, preview.hash)
  await vi.waitFor(() => expect(stopped).toBeDefined(), { timeout: 5000, interval: 25 })
  await stopped
  const journal = operations.get(operation.id)
  expect(journal.state).toBe('running')
  expect(journal.steps.find((step) => step.name === stepName)?.state).toBe('completed')
  spy.mockRestore()
  const resumed = new ProfileOperations(env.db, env.ingest, port)
  const calls = vi.spyOn(port, 'profileStep')
  await resumed.recover()
  await vi.waitFor(() => expect(resumed.get(operation.id).state).toBe('completed'), {
    timeout: 5000,
    interval: 25,
  })
  if (stepName !== 'verify_ready')
    expect(calls.mock.calls.map(([step]) => step)).not.toContain(stepName)
  await resumed.close()
})
test.each(['export', 'delete_profile', 'purge_identity'])(
  'delete recovery continues after verified %s without destructive retries',
  async (stepName) => {
    const added = await create()
    await finished(added.id)
    const operations = new ProfileOperations(env.db, env.ingest, port)
    const realStep = port.profileStep.bind(port)
    let stopped: Promise<void> | undefined
    const spy = vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
      const result = await realStep(step, context)
      if (step === stepName) stopped = operations.close()
      return result
    })
    const request = { kind: 'delete' as const, agentId: 'helper' }
    const preview = await operations.preview(request)
    const operation = await operations.begin(request, preview.hash)
    await vi.waitFor(() => expect(stopped).toBeDefined(), { timeout: 5000, interval: 25 })
    await stopped
    expect(operations.get(operation.id).state).toBe('running')
    spy.mockRestore()
    const resumed = new ProfileOperations(env.db, env.ingest, port)
    const calls = vi.spyOn(port, 'profileStep')
    await resumed.recover()
    await vi.waitFor(() => expect(resumed.get(operation.id).state).toBe('completed'), {
      timeout: 5000,
      interval: 25,
    })
    expect(calls.mock.calls.map(([step]) => step)).not.toContain(stepName)
    await resumed.close()
  },
)
test.each([
  'create_profile',
  'preserve_key',
  'configure_key',
  'model',
  'permissions',
  'install_bridge',
  'enable_bridge',
])('crash during %s stops recovery without repeating the external step', async (stepName) => {
  const added = await create()
  const complete = await finished(added.id)
  await app.close()
  const index = complete.steps.findIndex((step) => step.name === stepName)
  const crashed = {
    ...complete,
    state: 'running',
    nextStep: stepName,
    steps: complete.steps.map((step, i) => ({
      ...step,
      state: i < index ? 'completed' : i === index ? 'running' : 'pending',
    })),
  }
  env.db.sqlite
    .prepare("UPDATE profile_operations SET operation = ?, state = 'running' WHERE id = ?")
    .run(JSON.stringify(crashed), complete.id)
  env.db.sqlite
    .prepare("UPDATE agent_lifecycle SET state = 'setting_up' WHERE agent_id = 'helper'")
    .run()
  const call = vi.spyOn(port, 'profileStep')
  app = buildApp({
    config: loadConfig({ SCORE_HOME: env.home }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
  // Obtain a new paired session for the restarted app.
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
  const recovered = await finished(complete.id)
  expect(recovered).toMatchObject({ state: 'needs_attention', nextStep: stepName })
  expect(call).not.toHaveBeenCalled()
  expect((await app.inject('/api/agents/helper')).json()).toMatchObject({
    served: false,
    lifecycle: { state: 'needs_attention' },
  })
})

test('agent management needs loopback or a TLS remote connection', async () => {
  const { profileManagementAllowed } = await import('../../src/http/profiles.ts')
  expect(profileManagementAllowed({ host: '127.0.0.1', remote: undefined } as never)).toBe(true)
  expect(
    profileManagementAllowed({ host: '192.168.1.5', remote: { tlsCert: '/c.pem' } } as never),
  ).toBe(true)
  expect(
    profileManagementAllowed({ host: '192.168.1.5', remote: { insecureHttp: true } } as never),
  ).toBe(false)
})

test('a person can retry a harmless step that failed with a recorded error, never create_profile', async () => {
  const { HttpError } = await import('../../src/errors.ts')
  const real = port.profileStep.bind(port)
  let failPermissions = true
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'permissions' && failPermissions)
      throw new HttpError(409, 'conflict', 'Team permission readback did not match.')
    return real(step, context)
  })
  const added = await create()
  const stuck = await finished(added.id)
  expect(stuck).toMatchObject({
    state: 'needs_attention',
    nextStep: 'permissions',
    retryable: true,
  })
  failPermissions = false
  const retried = await mutate(`/api/agents/operations/${added.id}/retry`, {}, 'POST', {
    'idempotency-key': 'retry-permissions',
  })
  expect(retried.statusCode).toBe(200)
  await vi.waitFor(async () => expect((await finished(added.id)).state).toBe('completed'), {
    timeout: 5000,
  })
})

test('create_profile failures are not retryable from Score', async () => {
  const { HttpError } = await import('../../src/errors.ts')
  vi.spyOn(port, 'profileStep').mockImplementation(async (step) => {
    if (step === 'create_profile') throw new HttpError(409, 'conflict', 'Hermes refused.')
    throw new Error('unreachable')
  })
  const added = await create()
  expect(await finished(added.id)).toMatchObject({ nextStep: 'create_profile', retryable: false })
  const refused = await mutate(`/api/agents/operations/${added.id}/retry`, {}, 'POST', {
    'idempotency-key': 'retry-create',
  })
  expect(refused.statusCode).toBe(409)
})
