import { StreamHelloSchema, SystemStatusSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { createScenario } from '../../src/hermes/fake/scenario.ts'
import { startServer } from '../../src/start-server.ts'
import { readStream } from '../hub/sse-helpers.ts'

test('fake startup streams the scenario and exposes the same adapter status in system and hello', async () => {
  const home = mkdtempSync(join(tmpdir(), 'score-fake-startup-'))
  const abort = new AbortController()
  const replayAbort = new AbortController()
  const config = loadConfig({
    SCORE_HOME: home,
    SCORE_MODE: 'fake',
    SCORE_FAKE_SPEED: '100',
    SCORE_FAKE_LOOP: 'false',
  })
  const server = await startServer(config, {
    logger: false,
    listen: async (app) => {
      await app.ready()
    },
  })
  try {
    const stream = await readStream(server.app, '/api/stream', abort.signal)
    const hello = StreamHelloSchema.parse(stream.frames[0]?.data)
    const systemResponse = await server.app.inject('/api/system')
    expect(systemResponse.statusCode).toBe(200)
    const system = SystemStatusSchema.parse(systemResponse.json())
    expect(hello.data.system).toEqual(system)
    expect(system).toMatchObject({
      mode: 'fake',
      hermes: { reachable: true, servedProfiles: ['lead', 'builder', 'reviewer', 'designer'] },
      bridge: { producers: 0 },
    })
    const replay = await readStream(
      server.app,
      `/api/stream?since=0&epoch=${hello.data.epoch}`,
      replayAbort.signal,
    )
    // The script's own brief step, plus derived brief.upserted events whenever its status changes.
    const briefStatuses = () =>
      replay.frames.flatMap((frame) =>
        frame.type === 'brief.upserted'
          ? [(frame.data as { data: { status: string } }).data.status]
          : [],
      )
    await vi.waitFor(() => expect(briefStatuses().at(-1)).toBe('done'), { timeout: 5000 })
    const derived = briefStatuses().length - 1
    // Room updates that follow an approval or a finished reply in the same observation (who is busy changed with it).
    // The team room (PLAN 11.1b) is created once the agents are listed, and as every agent's room it also follows
    // who is busy: its updates are counted on their own.
    const isTeamRoom = (frame: (typeof replay.frames)[number]) =>
      frame.type === 'room.upserted' &&
      (frame.data as { data: { role?: string } }).data.role === 'team'
    await vi.waitFor(() => expect(replay.frames.some(isTeamRoom)).toBe(true), { timeout: 5000 })
    let afterApproval = false
    let derivedRooms = 0
    for (const frame of replay.frames) {
      if (isTeamRoom(frame)) continue
      if (frame.type?.startsWith('approval.') || frame.type === 'message.completed')
        afterApproval = true
      else if (frame.type === 'room.upserted') derivedRooms += afterApproval ? 1 : 0
      else afterApproval = false
    }
    // The scenario's room routes with exchanges (11.11), so its messages bring job.upserted for its one job.
    const jobFrames = replay.frames.filter((frame) => frame.type === 'job.upserted')
    expect(
      jobFrames.every(
        (frame) =>
          (frame.data as { data: { roomId: string } }).data.roomId === 'room-activity-feed',
      ),
    ).toBe(true)
    const base = createScenario(0).length + 4 + derived + derivedRooms + jobFrames.length
    const totalNow = () => base + replay.frames.filter(isTeamRoom).length
    await vi.waitFor(() => expect(replay.seqs).toHaveLength(totalNow()), { timeout: 5000 })
    const total = totalNow()
    expect(replay.seqs).toEqual(Array.from({ length: total }, (_, index) => index + 1))
    expect(
      replay.frames
        .filter(
          (frame) =>
            frame.id !== undefined &&
            frame.type !== 'room.upserted' &&
            frame.type !== 'job.upserted' &&
            frame.type !== 'brief.upserted',
        )
        .map((frame) => frame.type),
    ).toEqual(
      createScenario(0)
        .map((step) => step.kind)
        .filter((kind) => kind !== 'room.upserted' && kind !== 'brief.upserted'),
    )
    expect(briefStatuses()[0]).toBe('running')
    expect(stream.frames.some((frame) => frame.type === 'task.upserted')).toBe(true)
    expect(replay.failure).toBeUndefined()
    expect(stream.failure).toBeUndefined()
    abort.abort()
    replayAbort.abort()
    await Promise.all([stream.done, replay.done])
    await Promise.all([server.close(), server.close()])
    const restarted = await startServer(config, {
      logger: false,
      listen: async (app) => {
        await app.ready()
      },
    })
    await restarted.close()
  } finally {
    abort.abort()
    replayAbort.abort()
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('fake approvals share the real human API, outbox, and confirmed delivery attribution', async () => {
  const home = mkdtempSync(join(tmpdir(), 'score-fake-approvals-'))
  const server = await startServer(
    loadConfig({
      SCORE_HOME: home,
      SCORE_MODE: 'fake',
      SCORE_FAKE_SPEED: '100',
      SCORE_FAKE_LOOP: 'false',
    }),
    {
      logger: false,
      listen: async (app) => {
        await app.ready()
      },
    },
  )
  try {
    const paired = await server.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: server.pairingToken },
    })
    const cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
    let approvalId: string | undefined
    await vi.waitFor(
      async () => {
        const result = (await server.app.inject('/api/approvals')).json()
        approvalId = result.items.find((item: { actionable: boolean }) => item.actionable)?.id
        expect(approvalId).toBeDefined()
      },
      { timeout: 3000, interval: 10 },
    )
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/approvals/${approvalId}/decision`,
      headers: { cookie, 'x-score-client': 'web' },
      payload: { choice: 'once' },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json().decision).toBeNull()
    await vi.waitFor(async () => {
      const item = (await server.app.inject('/api/approvals?status=all'))
        .json()
        .items.find((item: { id: string }) => item.id === approvalId)
      expect(item).toMatchObject({
        status: 'approved',
        delivery: 'applied',
        decision: { by: 'you', choice: 'once' },
        actionable: false,
      })
    })
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/approvals/${approvalId}/decision`,
          headers: { cookie, 'x-score-client': 'web' },
          payload: { choice: 'deny' },
        })
      ).statusCode,
    ).toBe(409)
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
