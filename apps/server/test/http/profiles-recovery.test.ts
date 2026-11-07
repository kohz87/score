import { expect, test, vi } from 'vitest'
import { AgentPreviewSchema, type AgentStyle } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { ProfileOperations } from '../../src/domain/profiles.ts'
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
