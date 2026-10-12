import { hashKey, QueryObserver, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { StreamEvent } from '@score/contract'
import type { StreamSource } from './stream.ts'

export type StreamSnapshot<T> = { asOfSeq: number; data: T }
export type StreamQueryDefinition<T> = {
  key: QueryKey
  // `signal` aborts on a newer request, on idle/dispose and at the snapshot deadline.
  fetch: (signal?: AbortSignal) => Promise<StreamSnapshot<T>>
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
  /** A reconnect is a chance to retry a snapshot that failed behind a fence. */
  recover: () => void
  dispose: () => void
}

// An unobserved registration is dropped after this long (about TanStack's own gc time), together with its
// handle and cache listener; the next use registers it again.
const IDLE_EVICT_MS = 5 * 60_000
// A failed fenced snapshot is retried with doubling delays up to this cap.
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000
// Events held behind a fence beyond this restart the snapshot instead of growing without bound.
const MAX_BUFFERED_EVENTS = 2000
// A snapshot request that takes longer than this is abandoned and handled like any other failure.
const SNAPSHOT_TIMEOUT_MS = 30_000

export type RegistryOptions = {
  idleEvictMs?: number
  retryBaseMs?: number
  maxBuffered?: number
  snapshotTimeoutMs?: number
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
  options: RegistryOptions = {},
) {
  const idleEvictMs = options.idleEvictMs ?? IDLE_EVICT_MS
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS
  const maxBuffered = options.maxBuffered ?? MAX_BUFFERED_EVENTS
  const snapshotTimeoutMs = options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS
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
  const unsubscribeControl = stream.onControl(({ resync, first }) => {
    // A first connection has no replay cursor, so snapshots fetched while it was still connecting
    // may be missing events committed before the server's head; refetch them behind a fence.
    if (resync || first)
      entries.forEach((entry) => {
        void entry.refetch(true)
      })
    else entries.forEach((entry) => entry.recover())
  })

  function register<T>(definition: StreamQueryDefinition<T>) {
    const hash = hashKey(definition.key)
    // A key identifies one reducer and snapshot source for the lifetime of this registry.
    const existing = handles.get(hash)
    if (existing) return existing as StreamQueryHandle<T>
    let observers = 0
    let generation = 0
    let fetching = false
    // A cache that exists before this registration was made (e.g. after idle eviction) missed every
    // event in between, so it starts out untrusted.
    let fenced = queryClient.getQueryData(definition.key) !== undefined
    // Events were dropped while a snapshot was in flight, so that snapshot cannot be trusted.
    let overflowed = false
    let controller: AbortController | undefined
    let buffer: StreamEvent[] = []
    // Events that arrived while the cache was settled; applied together on the next frame.
    let pending: StreamEvent[] = []
    let disposed = false
    let evicted = false
    let failures = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
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
      if (disposed) return
      // The fence is recorded even while nobody observes: an idle cache may predate the epoch/reset
      // and must not be trusted when the next observer arrives.
      if (fence) {
        fenced = true
        pending = []
      }
      if (!observers) return
      // Settled-state events keep their order ahead of anything buffered during this fetch. A fence
      // drops them, like it drops the buffer: the client may have missed events around them.
      if (!fence) flush()
      // One snapshot request per entry: a newer one cancels the older.
      controller?.abort()
      const ctl = (controller = new AbortController())
      const timeout = setTimeout(
        () => ctl.abort(new Error('The snapshot request timed out.')),
        snapshotTimeoutMs,
      )
      const request = ++generation
      fetching = true
      overflowed = false
      if (fence) buffer = []
      publish('pending', null)
      // Separate request keys prevent TanStack's in-flight deduplication from merging generations.
      const requestKey = ['score-stream-snapshot', hash, request]
      try {
        const snapshot = await queryClient.fetchQuery({
          queryKey: requestKey,
          queryFn: () => abortable(definition.fetch(ctl.signal), ctl.signal),
          staleTime: 0,
          retry: false,
        })
        if (disposed || request !== generation || !observers) return
        if (overflowed) {
          // Events were dropped while this was in flight; one follow-up replaces it.
          void refetch(true)
          return
        }
        const next = buffer.sort((a, b) => a.seq - b.seq).reduce(apply, snapshot)
        buffer = []
        fetching = false
        fenced = false
        failures = 0
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
          // The fence stays until a snapshot succeeds, so keep trying rather than buffering forever.
          if (fenced || !previous) {
            clearTimeout(retryTimer)
            const delay = Math.min(retryBaseMs * 2 ** failures++, RETRY_MAX_MS)
            retryTimer = setTimeout(() => void recover(), delay)
          }
        }
      } finally {
        clearTimeout(timeout)
        if (controller === ctl) controller = undefined
        queryClient.removeQueries({ queryKey: requestKey, exact: true })
      }
    }
    function recover() {
      // A cacheless failure needs the same retry as a fenced one: nothing else would fetch it again.
      if ((fenced || !cached()) && !fetching && observers > 0 && !disposed) void refetch(fenced)
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
        if (!definition.types.includes(event.type)) return
        if (!observers) {
          // An idle cache misses this event for good: it stays untrusted until a snapshot succeeds.
          if (cached()) {
            fenced = true
            pending = []
          }
          return
        }
        if (fetching || fenced || !cached()) {
          if (overflowed) return
          buffer.push(event)
          // Never hold an unbounded backlog, in any buffering state. Dropped events make the cache
          // untrustworthy (fence) and a snapshot in flight unusable (one follow-up replaces it).
          if (buffer.length > maxBuffered) {
            buffer = []
            fenced = true
            if (fetching) overflowed = true
          }
        } else {
          pending.push(event)
          markDirty(entry)
        }
      },
      flush,
      recover,
      dispose() {
        disposed = true
        clearTimeout(retryTimer)
        clearTimeout(idleTimer)
        controller?.abort()
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
      // After eviction this handle forwards everything to the current registration, not just subscribe.
      getSnapshot: () =>
        (evicted ? (handles.get(hash)?.getSnapshot() ?? state) : state) as StreamQueryState<T>,
      refetch: (): Promise<void> =>
        evicted ? (handles.get(hash)?.refetch() ?? Promise.resolve()) : refetch(),
      subscribe(listener) {
        // The registration was evicted while idle: register again and subscribe to the fresh one.
        if (evicted) return register(definition).subscribe(listener)
        listeners.add(listener)
        clearTimeout(idleTimer)
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
            controller?.abort()
            generation++
            fetching = false
            overflowed = false
            buffer = []
            clearTimeout(retryTimer)
            idleTimer = setTimeout(() => {
              if (observers > 0) return
              evicted = true
              entry.dispose()
              entries.delete(hash)
              handles.delete(hash)
            }, idleEvictMs)
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

function abortable<V>(promise: Promise<V>, signal: AbortSignal): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    promise.then(resolve, reject)
  })
}
