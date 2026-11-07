import { expect, test, vi } from 'vitest'
import { AgentPreviewSchema, type AgentStyle } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { requestRunApproval } from '../../src/domain/approvals.ts'
import { writeBaseline } from '../../src/domain/team-rules.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { McpAccessStore } from '../../src/mcp/access.ts'
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
