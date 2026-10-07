import { afterEach, beforeEach, expect, test } from 'vitest'
import { event, hello, initialTime, setup } from './helpers.ts'

let server: ReturnType<typeof setup>
beforeEach(() => {
  server = setup()
})
afterEach(async () => {
  await server.close()
})

test('live system bridge status counts recently seen producers and shows the latest isolation', async () => {
  expect((await server.app.inject('/api/system')).json().bridge).toEqual({
    producers: 0,
    lastSeenAt: null,
    isolation: 'unknown',
  })
  const first = await server.token()
  server.setNow(initialTime + 1000)
  await server.token({ ...hello, incarnation: 'worker-second', isolation: 'host' })
  expect((await server.app.inject('/api/system')).json().bridge).toEqual({
    producers: 2,
    lastSeenAt: new Date(initialTime + 1000).toISOString(),
    isolation: 'host',
  })
  server.setNow(initialTime + 5 * 60_000 + 1001)
  expect((await server.app.inject('/api/system')).json().bridge.producers).toBe(0)
  await server.send(first, [event(1)])
  expect((await server.app.inject('/api/system')).json().bridge).toEqual({
    producers: 1,
    lastSeenAt: new Date(initialTime + 5 * 60_000 + 1001).toISOString(),
    isolation: 'in_process',
  })
})

test('fake mode retains its adapter bridge status even if bridge routes are registered', async () => {
  const fake = setup({ mode: 'fake' })
  try {
    const before = (await fake.app.inject('/api/system')).json().bridge
    await fake.token()
    expect((await fake.app.inject('/api/system')).json().bridge).toEqual(before)
  } finally {
    await fake.close()
  }
})
