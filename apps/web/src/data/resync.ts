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
  flush: () => void
  refetch: (fence?: boolean) => Promise<void>
  dispose: () => void
}

// Calls `run` once, on the next animation frame. Hidden tabs never get frames, so they use a short
// timer instead, and a backstop timer covers a tab that is hidden after the frame was requested.
// `cancel` drops it. Tests inject their own.
export type FrameScheduler = (run: () => void) => () => void
export const defaultFrameScheduler: FrameScheduler = (run) => {
  let done = false
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout>
  const fire = () => {
    if (done) return
    done = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearTimeout(timer)
    run()
  }
  const visible = typeof document === 'undefined' || !document.hidden
  if (visible && typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(fire)
    timer = setTimeout(fire, 100)
  } else timer = setTimeout(fire, 16)
  return () => {
    done = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}

// Applies events in the same tick; page tests use it so their assertions need not wait for a frame.
export const immediateFrameScheduler: FrameScheduler = (run) => {
  run()
  return () => {}
}

export function createStreamQueryRegistry(
  queryClient: QueryClient,
  stream: StreamSource,
  schedule: FrameScheduler = defaultFrameScheduler,
) {
  const entries = new Map<string, Entry>()
  // Entries with queued events share one frame callback; each entry applies its queue in one write.
  const dirty = new Set<Entry>()
  let cancelFrame: (() => void) | undefined
  function runFrame() {
    cancelFrame = undefined
    const batch = [...dirty]
    dirty.clear()
    batch.forEach((entry) => entry.flush())
  }
  function markDirty(entry: Entry) {
    dirty.add(entry)
    if (cancelFrame) return
    let ran = false
    const cancel = schedule(() => {
      ran = true
      runFrame()
    })
    // A scheduler may run the frame before it returns (tests); there is nothing left to cancel then.
    if (!ran) cancelFrame = cancel
  }
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
    // Events that arrived while the cache was settled; applied together on the next frame.
    let pending: StreamEvent[] = []
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
      // Settled-state events keep their order ahead of anything buffered during this fetch. A fence
      // drops them, like it drops the buffer: the client may have missed events around them.
      if (fence) pending = []
      else flush()
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
    function flush() {
      dirty.delete(entry)
      if (!pending.length) return
      const events = pending
      pending = []
      const current = cached()
      if (!current) return
      const next = events.reduce(apply, current)
      if (next === current) return
      queryClient.setQueryData(definition.key, next)
      publish('success', null)
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
          pending.push(event)
          markDirty(entry)
        }
      },
      flush,
      dispose() {
        disposed = true
        generation++
        buffer = []
        pending = []
        dirty.delete(entry)
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
            flush()
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
      cancelFrame?.()
      cancelFrame = undefined
      dirty.clear()
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
