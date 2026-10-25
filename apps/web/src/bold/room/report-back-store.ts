import { useEffect, useSyncExternalStore } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

const POLL_MS = 1500
const POLL_LIMIT_MS = 120_000

type Entry = {
  key: string | null
  sending: boolean
  error: string | null
  stillSending: boolean
  pollStartedAt: number | null
  timer: ReturnType<typeof setInterval> | null
  watchers: number
  refetch: (() => void) | null
}

const EMPTY: Entry = {
  key: null,
  sending: false,
  error: null,
  stillSending: false,
  pollStartedAt: null,
  timer: null,
  watchers: 0,
  refetch: null,
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function entryOf(jobId: string): Entry {
  return entries.get(jobId) ?? EMPTY
}

function publish(jobId: string, next: Entry): void {
  entries.set(jobId, next)
  for (const listener of listeners) listener()
}

function update(jobId: string, change: (current: Entry) => Entry): void {
  const current = entryOf(jobId)
  const next = change(current)
  if (next !== current) publish(jobId, next)
}

function stopPoll(entry: Entry): Entry {
  if (entry.timer !== null) clearInterval(entry.timer)
  return { ...entry, timer: null, pollStartedAt: null }
}

function clear(jobId: string): void {
  const current = entries.get(jobId)
  if (!current) return
  stopPoll(current)
  entries.delete(jobId)
  for (const listener of listeners) listener()
}

/** One poll per job, wherever several report-back lines are mounted. */
function startPoll(jobId: string): void {
  update(jobId, (current) => {
    if (current.timer !== null || current.stillSending) return current
    const startedAt = current.pollStartedAt ?? Date.now()
    const timer = setInterval(() => {
      const entry = entryOf(jobId)
      if (!entry.refetch) return
      if (Date.now() - startedAt >= POLL_LIMIT_MS) {
        publish(jobId, { ...stopPoll(entry), stillSending: true })
        return
      }
      entry.refetch()
    }, POLL_MS)
    return { ...current, timer, pollStartedAt: startedAt }
  })
}

function syncState(jobId: string, state: string | null, refetch: () => void): void {
  const current = entryOf(jobId)
  // The refetch handle is bookkeeping, not rendered state: storing it must not schedule a render (a caller may pass a
  // fresh closure each render, which would otherwise make the effect and the store ping-pong).
  if (current.refetch !== refetch) entries.set(jobId, { ...current, refetch })
  if (state === 'confirmed' || state === 'off' || state === 'waiting') {
    clear(jobId)
    return
  }
  if (state === 'not_confirmed') {
    update(jobId, (current) =>
      current.timer === null && !current.sending
        ? current
        : { ...stopPoll(current), key: null, sending: false, stillSending: false },
    )
    return
  }
  if (state === 'sending') {
    update(jobId, (current) => (current.key === null ? current : { ...current, key: null }))
    startPoll(jobId)
  }
}

function watch(jobId: string): () => void {
  const current = entryOf(jobId)
  entries.set(jobId, { ...current, watchers: current.watchers + 1 })
  return () => {
    const entry = entryOf(jobId)
    if (entry.watchers <= 1) {
      const stopped = stopPoll(entry)
      entries.set(jobId, { ...stopped, watchers: 0, refetch: null })
    } else entries.set(jobId, { ...entry, watchers: entry.watchers - 1 })
  }
}

function messageFor(failure: unknown): string {
  if (failure instanceof ApiError) {
    if (failure.status === 401 || failure.status === 403) return 'Pair this browser first.'
    if (failure.status === 409) return failure.message
  }
  return 'Couldn’t send the result back. Try again.'
}

export async function sendReportBack(jobId: string, refetch: () => void): Promise<void> {
  const current = entryOf(jobId)
  if (current.sending) return
  const key = current.key ?? newId()
  publish(jobId, {
    ...current,
    key,
    sending: true,
    error: null,
    stillSending: false,
    refetch,
  })
  try {
    await apiFetch(`jobs/${encodeURIComponent(jobId)}/report-back`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: '{}',
    })
    update(jobId, (entry) => ({ ...entry, sending: false }))
    refetch()
    startPoll(jobId)
  } catch (failure) {
    const definitive = failure instanceof ApiError && failure.status >= 400 && failure.status < 500
    update(jobId, (entry) => ({
      ...entry,
      key: definitive ? null : entry.key,
      sending: false,
      error: messageFor(failure),
    }))
  }
}

/** Shared by every inline line and the strip's decision card for one job. */
export function useReportBack(jobId: string, state: string | null, refetch: () => void) {
  const entry = useSyncExternalStore(subscribe, () => entryOf(jobId))
  useEffect(() => {
    syncState(jobId, state, refetch)
    return watch(jobId)
  }, [jobId, refetch, state])
  return {
    ...entry,
    send: () => sendReportBack(jobId, refetch),
  }
}

export function resetReportBackStore(): void {
  for (const entry of entries.values()) if (entry.timer !== null) clearInterval(entry.timer)
  entries.clear()
  for (const listener of listeners) listener()
}
