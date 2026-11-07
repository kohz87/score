import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { StreamEvent, SystemStatus } from '@score/contract'
import { createStreamClient, type StreamClient } from './stream.ts'
import {
  createStreamQueryRegistry,
  defineStreamQuery,
  type FrameScheduler,
  type StreamQueryRegistry,
  type StreamSnapshot,
} from './resync.ts'
import { createQueryClient } from './query-client.ts'

export class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  closed = false
  constructor(readonly url: string) {
    super()
    MockEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
  frame(value: unknown, type = 'message', id = '') {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value), lastEventId: id }))
  }
  error() {
    this.dispatchEvent(new Event('error'))
  }
}
export const system: SystemStatus = {
  mode: 'fake',
  hermes: { version: null, reachable: true, apiServer: true, capabilities: [], servedProfiles: [] },
  bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
  compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
  agentIsolation: 'same_user',
  degraded: [],
}
export function hello(source: MockEventSource, epoch = 'epoch-one') {
  source.frame(
    { type: 'stream.hello', data: { epoch, headSeq: 0, mode: 'fake', system } },
    'stream.hello',
  )
}
export function delta(source: MockEventSource, seq: number, append = '!') {
  source.frame(
    {
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'message.delta',
      data: { messageId: 'message', roomId: 'room', append },
    },
    'message.delta',
    String(seq),
  )
}
// A hand-driven animation frame: tests decide when the batch lands.
function manualFrames() {
  let callback: (() => void) | undefined
  let requested = 0
  return {
    schedule: ((run) => {
      callback = run
      requested++
      return () => {
        if (callback === run) callback = undefined
      }
    }) as FrameScheduler,
    flush() {
      const run = callback
      callback = undefined
      run?.()
    },
    get pending() {
      return callback !== undefined
    },
    get requested() {
      return requested
    },
  }
}
export const clients: StreamClient[] = []
export const registries: StreamQueryRegistry[] = []
export const queryClients: ReturnType<typeof createQueryClient>[] = []
export function setup() {
  const client = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  const queryClient = createQueryClient()
  const frames = manualFrames()
  const queries = createStreamQueryRegistry(queryClient, client, frames.schedule)
  clients.push(client)
  registries.push(queries)
  queryClients.push(queryClient)
  return { client, queryClient, queries, frames, source: MockEventSource.instances.at(-1)! }
}
export function definition(key = 'text') {
  const requests: ReturnType<typeof Promise.withResolvers<StreamSnapshot<string>>>[] = []
  const fetch = vi.fn(() => {
    const request = Promise.withResolvers<StreamSnapshot<string>>()
    requests.push(request)
    return request.promise
  })
  const reduce = vi.fn((data: string, event: StreamEvent) =>
    event.type === 'message.delta' ? data + event.data.append : data,
  )
  return {
    def: defineStreamQuery({ key: [key], fetch, types: ['message.delta'], reduce }),
    requests,
    fetch,
    reduce,
  }
}
export async function resolve(
  request: ReturnType<typeof Promise.withResolvers<StreamSnapshot<string>>>,
  data: string,
  asOfSeq: number,
) {
  request.resolve({ data, asOfSeq })
  await vi.waitFor(() => expect(queryClients.at(-1)!.isFetching()).toBe(0))
}
beforeEach(() => {
  MockEventSource.instances = []
})
afterEach(() => {
  cleanup()
  registries.splice(0).forEach((registry) => registry.dispose())
  clients.splice(0).forEach((client) => client.close())
  queryClients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
  vi.restoreAllMocks()
})
