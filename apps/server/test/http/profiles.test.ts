import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  AgentOperationSchema,
  AgentPreviewSchema,
  type AgentOperation,
  type AgentStyle,
} from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { requestRunApproval } from '../../src/domain/approvals.ts'
import { ProfileOperations } from '../../src/domain/profiles.ts'
import { writeBaseline } from '../../src/domain/team-rules.ts'
import { McpAccessStore } from '../../src/mcp/access.ts'
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
async function create(body: Omit<typeof input, 'style'> & { style: AgentStyle } = input) {
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
test('PLAN 10.2: a new agent keeps its new shape, and a look or pack in the request is dropped', async () => {
  const forged = {
    rev: 'forged',
    activities: ['idle' as const],
    name: null,
    credits: null,
    floor: 0,
  }
  const body = {
    ...input,
    style: { color: '#19C39A', shape: 'cloud' as const, look: 'ring', pack: forged },
  }
  const operation = await create(body)
  await finished(operation.id)
  expect((await app.inject('/api/agents/helper')).json().style).toEqual({
    color: '#19C39A',
    shape: 'cloud',
  })
  expect(env.db.sqlite.prepare('SELECT look, pack_rev, pack_meta FROM agent_styles').all()).toEqual(
    // The request's look ('ring') is dropped; the unused column keeps its default.
    [{ look: 'cut', pack_rev: null, pack_meta: null }],
  )
  // Nothing of it is kept in the operation journal either.
  const operations = env.db.sqlite.prepare('SELECT request FROM profile_operations').all()
  expect(JSON.stringify(operations)).not.toContain('forged')
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
  // MCP access (7.4d) is revoked and reset with the agent.
  const mcp = new McpAccessStore(env.db)
  mcp.patch('helper', { enabled: true, writesEnabled: true })
  const mcpToken = mcp.issueToken('helper')
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
  expect(mcp.agentForToken(mcpToken)).toBeUndefined()
  expect(mcp.get('helper')).toEqual({
    enabled: false,
    writesEnabled: false,
    hasToken: false,
    tokenCreatedAt: null,
  })
  expect(
    env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_access WHERE agent_id = ?').get('helper'),
  ).toEqual({ n: 0 })
  // Retained History and Watch stay reachable once the agent has left the Hermes roster.
  expect((await app.inject('/api/agents/helper/history')).statusCode).toBe(200)
  expect((await app.inject('/api/agents/helper/watch')).statusCode).toBe(200)
  const retainedRoom = (await app.inject(`/api/rooms/${room.json().id}`)).json().room
  expect(retainedRoom).toMatchObject({ members: ['builder'], leadAgentId: null })
  // A retired name is reused only on purpose (2.0.8): no blocker, but the preview says so and create needs the confirm.
  const reuse = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'create', ...input })).json(),
  )
  expect(reuse.blockers).toEqual([])
  expect(reuse.reusesName).toBe(true)
  expect(reuse.effects.join(' ')).toMatch(/keep the name helper/)
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
test('team rules changed during provisioning are applied to the new agent instead of stranding it', async () => {
  const real = port.profileStep.bind(port)
  let changed = false
  const spy = vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'permissions' && !changed) {
      changed = true
      writeBaseline(
        env.db.sqlite,
        { mode: 'manual', goAhead: [], never: [] },
        new Date().toISOString(),
      )
    }
    return real(step, context)
  })
  const added = await create()
  expect((await finished(added.id)).state).toBe('completed')
  const permissionCalls = spy.mock.calls.filter(([step]) => step === 'permissions')
  expect(permissionCalls).toHaveLength(2)
  expect(permissionCalls[1]![1].baseline.mode).toBe('manual')
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
  expect(profileManagementAllowed({ host: '192.168.1.5', remote: {} } as never)).toBe(false)
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
test('create with a provider sets model and provider together and names it in the plan', async () => {
  const setModel = vi.spyOn(port, 'setAgentModel')
  const body = { ...input, model: 'gpt-6.1-sol', provider: 'openai-codex' }
  const preview = AgentPreviewSchema.parse(
    (await mutate('/api/agents/preview', { kind: 'create', ...body })).json(),
  )
  expect(preview.effects).toContain('Set the model to gpt-6.1-sol via ChatGPT (Codex).')
  const other = AgentPreviewSchema.parse(
    (
      await mutate('/api/agents/preview', {
        kind: 'create',
        ...body,
        provider: 'nous',
      })
    ).json(),
  )
  expect(other.hash).not.toBe(preview.hash)
  const operation = await create(body)
  expect(await finished(operation.id)).toMatchObject({ state: 'completed' })
  expect(setModel).toHaveBeenCalledWith('helper', {
    model: 'gpt-6.1-sol',
    provider: 'openai-codex',
  })
})

test('after an interrupted create_profile the person can confirm it finished, and Score continues to Ready', async () => {
  const real = port.profileStep.bind(port)
  let interrupt = true
  vi.spyOn(port, 'profileStep').mockImplementation(async (step, context) => {
    if (step === 'create_profile' && interrupt) {
      interrupt = false
      // The profile was created, but Score lost the result (a restart mid-step).
      await real(step, context)
      throw new Error('connection reset')
    }
    return real(step, context)
  })
  const added = await create()
  expect(await finished(added.id)).toMatchObject({
    state: 'needs_attention',
    nextStep: 'create_profile',
    retryable: false,
    confirmable: true,
  })
  const wrongStep = await mutate(
    `/api/agents/operations/${added.id}/confirm`,
    { step: 'model' },
    'POST',
    {
      'idempotency-key': 'confirm-wrong',
    },
  )
  expect(wrongStep.statusCode).toBe(409)
  const confirmed = await mutate(
    `/api/agents/operations/${added.id}/confirm`,
    { step: 'create_profile' },
    'POST',
    { 'idempotency-key': 'confirm-create' },
  )
  expect(confirmed.statusCode).toBe(200)
  await vi.waitFor(async () => expect((await finished(added.id)).state).toBe('completed'), {
    timeout: 5000,
  })
})

test('a recorded failure is never confirmable, and an interrupted create that made nothing cannot continue', async () => {
  const { HttpError } = await import('../../src/errors.ts')
  vi.spyOn(port, 'profileStep').mockImplementation(async (step) => {
    if (step === 'create_profile') throw new HttpError(409, 'conflict', 'Profile already exists.')
    throw new Error('unreachable')
  })
  const refusedOp = await create()
  // "Continue" after "already exists" would adopt someone else's profile.
  expect(await finished(refusedOp.id)).toMatchObject({ confirmable: false })
  expect(
    (
      await mutate(
        `/api/agents/operations/${refusedOp.id}/confirm`,
        { step: 'create_profile' },
        'POST',
        {
          'idempotency-key': 'confirm-recorded',
        },
      )
    ).statusCode,
  ).toBe(409)
})

test('Score refuses to continue an interrupted create when the profile doesn’t exist', async () => {
  vi.spyOn(port, 'profileStep').mockImplementation(async (step) => {
    if (step === 'create_profile') throw new Error('connection reset before anything happened')
    throw new Error('unreachable')
  })
  const added = await create()
  expect(await finished(added.id)).toMatchObject({ confirmable: true })
  const response = await mutate(
    `/api/agents/operations/${added.id}/confirm`,
    { step: 'create_profile' },
    'POST',
    { 'idempotency-key': 'confirm-nothing' },
  )
  expect(response.statusCode).toBe(409)
  expect(response.json().error.message).toContain('doesn’t exist')
})

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
