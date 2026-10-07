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
    const total = createScenario(0).length
    await vi.waitFor(() => expect(replay.seqs).toHaveLength(total), { timeout: 5000 })
    expect(replay.seqs).toEqual(Array.from({ length: total }, (_, index) => index + 1))
    expect(
      replay.frames.filter((frame) => frame.id !== undefined).map((frame) => frame.type),
    ).toEqual(createScenario(0).map((step) => step.kind))
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
