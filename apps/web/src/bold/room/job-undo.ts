import { JobSchema, type Job } from '@score/contract'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { changeCachedJob } from './room-queries.ts'

const UNDO_MS = 10_000
const NOTICE_MS = 5_000

type UndoState = {
  job: Job | null
  restoring: boolean
  notice: string | null
  error: string | null
}

const EMPTY: UndoState = { job: null, restoring: false, notice: null, error: null }
let state = EMPTY
let queryClient: QueryClient | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function publish(next: UndoState): void {
  state = next
  for (const listener of listeners) listener()
}

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

export function beginJobUndo(client: QueryClient, job: Job): void {
  queryClient = client
  clearTimer()
  publish({ job, restoring: false, notice: null, error: null })
  timer = setTimeout(() => {
    timer = null
    publish({ ...state, job: null })
  }, UNDO_MS)
}

export function dismissJobUndo(): void {
  clearTimer()
  publish(EMPTY)
}

function restoreError(failure: unknown): string {
  if (failure instanceof ApiError && failure.status === 404)
    return 'That job can’t be restored any more'
  if (failure instanceof ApiError && failure.message) return failure.message
  return 'Couldn’t restore that job. Try again.'
}

export async function undoJobDelete(): Promise<void> {
  const job = state.job
  const client = queryClient
  if (!job || !client || state.restoring) return
  clearTimer()
  publish({ ...state, restoring: true, error: null })
  try {
    const restored = JobSchema.parse(
      await apiFetch(`jobs/${encodeURIComponent(job.id)}/restore`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      }),
    )
    changeCachedJob(client, restored, 'upsert')
    // A second delete while this restore was in flight owns the toast now: leave its Undo alone.
    if (state.job?.id !== job.id) return
    publish({ job: null, restoring: false, notice: `Restored “${restored.title}”.`, error: null })
    timer = setTimeout(() => {
      timer = null
      publish({ ...state, notice: null })
    }, NOTICE_MS)
  } catch (failure) {
    if (state.job?.id !== job.id) return
    clearTimer()
    publish({ job: null, restoring: false, notice: null, error: restoreError(failure) })
  }
}

export function useJobUndo(): UndoState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

export function resetJobUndo(): void {
  clearTimer()
  queryClient = null
  publish(EMPTY)
}
