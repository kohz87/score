import { hashKey, QueryObserver, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { StreamEvent } from '@score/contract'
import type { StreamSource } from './stream.ts'

export type StreamSnapshot<T> = { asOfSeq: number; data: T }
export type StreamQueryDefinition<T> = {
  key: QueryKey
  fetch: () => Promise<StreamSnapshot<T>>
  types: StreamEvent['type'][]
  reduce: (data: T, event: StreamEvent) => T
}
export type StreamQueryState<T> = {
  data: T | undefined
  asOfSeq: number | undefined
  status: 'pending' | 'success' | 'error'
  error: unknown
}
export function defineStreamQuery<T>(definition: StreamQueryDefinition<T>) {
  return definition
}

type Entry = {
  event: (event: StreamEvent) => void
  refetch: (fence?: boolean) => Promise<void>
  dispose: () => void
}

export function createStreamQueryRegistry(queryClient: QueryClient, stream: StreamSource) {
  const entries = new Map<string, Entry>()
  const unsubscribe = stream.subscribe((event) => entries.forEach((entry) => entry.event(event)))
  // Every resync fences: after a reset or an epoch change the client may have missed events, so
  // buffered deltas must never be applied on top of the old snapshot, even if the refetch fails.
  const unsubscribeControl = stream.onControl(({ resync }) => {
    if (resync)
      entries.forEach((entry) => {
        void entry.refetch(true)
      })
  })

  function register<T>(definition: StreamQueryDefinition<T>) {
    const hash = hashKey(definition.key)
    // A key identifies one reducer and snapshot source for the lifetime of this registry.
    const existing = handles.get(hash)
    if (existing) return existing as StreamQueryHandle<T>
    let observers = 0
    let generation = 0
    let fetching = false
    let fenced = false
    let buffer: StreamEvent[] = []
    let disposed = false
    let releaseObserver: (() => void) | undefined
    const listeners = new Set<() => void>()
    const cached = () => queryClient.getQueryData<StreamSnapshot<T>>(definition.key)
    let state: StreamQueryState<T> = {
      data: cached()?.data,
      asOfSeq: cached()?.asOfSeq,
      status: cached() ? 'success' : 'pending',
      error: null,
    }
    function publish(status = state.status, error: unknown = state.error) {
      const snapshot = cached()
      state = { data: snapshot?.data, asOfSeq: snapshot?.asOfSeq, status, error }
      listeners.forEach((listener) => listener())
    }
    function apply(snapshot: StreamSnapshot<T>, event: StreamEvent): StreamSnapshot<T> {
      return event.seq <= snapshot.asOfSeq
        ? snapshot
        : {
            data: definition.reduce(snapshot.data, event),
            asOfSeq: event.seq,
          }
    }
    async function refetch(fence = false) {
      if (!observers || disposed) return
      const request = ++generation
      fetching = true
      if (fence) {
        buffer = []
        fenced = true
      }
      publish('pending', null)
      // Separate request keys prevent TanStack's in-flight deduplication from merging generations.
      const requestKey = ['score-stream-snapshot', hash, request]
      try {
        const snapshot = await queryClient.fetchQuery({
          queryKey: requestKey,
          queryFn: definition.fetch,
          staleTime: 0,
          retry: false,
        })
        if (disposed || request !== generation || !observers) return
        const next = buffer.sort((a, b) => a.seq - b.seq).reduce(apply, snapshot)
        buffer = []
        fetching = false
        fenced = false
        queryClient.setQueryData(definition.key, next)
        publish('success', null)
      } catch (error) {
        if (!disposed && request === generation && observers) {
          fetching = false
          const previous = cached()
          if (previous && !fenced) {
            queryClient.setQueryData(
              definition.key,
              buffer.sort((a, b) => a.seq - b.seq).reduce(apply, previous),
            )
            buffer = []
          }
          publish('error', error)
        }
      } finally {
        queryClient.removeQueries({ queryKey: requestKey, exact: true })
      }
    }
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash === hash) publish()
    })
    const entry: Entry = {
      refetch,
      event(event) {
        if (!observers || !definition.types.includes(event.type)) return
        if (fetching || fenced || !cached()) buffer.push(event)
        else {
          if (event.seq <= cached()!.asOfSeq) return
          queryClient.setQueryData(definition.key, apply(cached()!, event))
          publish('success', null)
        }
      },
      dispose() {
        disposed = true
        generation++
        buffer = []
        releaseObserver?.()
        unsubscribeCache()
        listeners.clear()
      },
    }
    entries.set(hash, entry)
    const handle: StreamQueryHandle<T> = {
      getSnapshot: () => state,
      refetch,
      subscribe(listener) {
        listeners.add(listener)
        if (++observers === 1) {
          // Keep the canonical cache entry alive while the hook has subscribers.
          const observer = new QueryObserver<StreamSnapshot<T>>(queryClient, {
            queryKey: definition.key,
            enabled: false,
          })
          releaseObserver = observer.subscribe(() => {})
          void refetch()
        }
        return () => {
          listeners.delete(listener)
          if (--observers === 0) {
            releaseObserver?.()
            releaseObserver = undefined
            generation++
            fetching = false
            buffer = []
          }
        }
      },
    }
    handles.set(hash, handle as StreamQueryHandle<unknown>)
    return handle
  }
  const handles = new Map<string, StreamQueryHandle<unknown>>()
  return {
    register,
    dispose() {
      unsubscribe()
      unsubscribeControl()
      entries.forEach((entry) => entry.dispose())
      entries.clear()
      handles.clear()
    },
  }
}
export type StreamQueryHandle<T> = {
  getSnapshot: () => StreamQueryState<T>
  subscribe: (listener: () => void) => () => void
  refetch: () => Promise<void>
}
export type StreamQueryRegistry = ReturnType<typeof createStreamQueryRegistry>
