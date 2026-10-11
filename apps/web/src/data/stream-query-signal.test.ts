import { QueryClient } from '@tanstack/react-query'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { roomsQuery } from '../routes/chat/queries.ts'
import { sessionContextQuery } from '../routes/chat/room-actions.ts'
import {
  createStreamQueryRegistry,
  immediateFrameScheduler,
  type RegistryOptions,
  type StreamQueryDefinition,
} from './resync.ts'
import type { StreamSource } from './stream.ts'

// S2-012: a cancelled snapshot must cancel the network request behind it, not only stop waiting for it.

const idleStream: StreamSource = {
  subscribe: () => () => {},
  onControl: () => () => {},
} as unknown as StreamSource

let calls: { url: string; signal: AbortSignal }[]
beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) throw new Error('fetch was called without a signal')
      calls.push({ url: String(input), signal })
      // A request that never answers, like a stalled connection; only the signal ends it.
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(options: RegistryOptions = {}) {
  const queryClient = new QueryClient()
  const queries = createStreamQueryRegistry(
    queryClient,
    idleStream,
    immediateFrameScheduler,
    options,
  )
  return { queries, queryClient }
}
const erase = <T>(definition: StreamQueryDefinition<T>) =>
  definition as unknown as StreamQueryDefinition<unknown>
const definitions: (() => StreamQueryDefinition<unknown>)[] = [
  () => erase(sessionContextQuery('builder', 'score-r-builder')),
  () => erase(roomsQuery),
]

for (const make of definitions) {
  const name = make().key.join('/')

  test(`${name}: the network request is aborted at the snapshot deadline`, async () => {
    vi.useFakeTimers()
    const { queries } = setup({ snapshotTimeoutMs: 5000 })
    queries.register(make()).subscribe(() => {})
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls[0]!.signal.aborted).toBe(true)
  })

  test(`${name}: a newer snapshot request aborts the older network request`, async () => {
    const { queries } = setup()
    const handle = queries.register(make())
    handle.subscribe(() => {})
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    void handle.refetch()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(calls[1]!.signal.aborted).toBe(false)
  })

  test(`${name}: losing the last observer aborts the request, and eviction leaves nothing running`, async () => {
    vi.useFakeTimers()
    const { queries } = setup({ idleEvictMs: 1000 })
    const unsubscribe = queries.register(make()).subscribe(() => {})
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    unsubscribe()
    expect(calls[0]!.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
  })

  test(`${name}: disposing the registry aborts the request`, async () => {
    const { queries } = setup()
    queries.register(make()).subscribe(() => {})
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    queries.dispose()
    expect(calls[0]!.signal.aborted).toBe(true)
  })
}

// A guard for definitions nobody has written yet: every stream query's fetcher must take the signal and hand it to
// each apiFetch call inside it, or a cancelled snapshot keeps its request running.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) ? [path] : []
  })
}

function callEnd(text: string, open: number): number {
  let depth = 1
  let at = open
  while (depth > 0) {
    const char = text[at++]
    if (char === '(') depth++
    else if (char === ')') depth--
  }
  return at
}

test('every stream query definition passes its AbortSignal to every apiFetch call', () => {
  const problems: string[] = []
  let definitionsSeen = 0
  for (const file of sourceFiles(join(__dirname, '..'))) {
    const text = readFileSync(file, 'utf8')
    if (file.endsWith('resync.ts') || !/defineStreamQuery\b/.test(text)) continue
    for (const match of text.matchAll(/(?:async )?fetch\(([^)]*)\)\s*\{/g)) {
      definitionsSeen++
      const body = text.slice(match.index + match[0].length, text.indexOf('types:', match.index))
      const where = `${file.replace(/^.*\/src\//, 'src/')} (${text.slice(0, match.index).split('\n').length})`
      if (!/\bsignal\b/.test(match[1]!)) problems.push(`${where}: fetch does not take the signal`)
      for (const call of body.matchAll(/apiFetch\(/g)) {
        const end = callEnd(body, call.index + call[0].length)
        if (!/\bsignal\b/.test(body.slice(call.index, end)))
          problems.push(`${where}: an apiFetch call ignores the signal`)
      }
    }
  }
  expect(definitionsSeen).toBeGreaterThanOrEqual(16)
  expect(problems).toEqual([])
})
