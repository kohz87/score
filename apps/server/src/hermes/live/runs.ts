import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import type { ObservationSink } from '../port.ts'
import { CredentialsUnavailable } from './credentials.ts'
import { GatewayClient, HermesHttpError } from './gateway.ts'
import { resumableSse, SseHttpError, type SseBackoff } from './sse-client.ts'
import {
  readRun,
  runDraft,
  runLifecycle,
  runLostObservation,
  runStatusObservation,
  statusApprovalObservation,
  translateRunEvent,
  type RunContext,
  type RunMetrics,
} from './translate.ts'

export interface FollowOptions {
  db: ScoreDb
  gateway: GatewayClient
  sink: ObservationSink
  context: RunContext
  metrics: RunMetrics
  signal?: AbortSignal
  backoff?: SseBackoff
  pollIntervalMs?: number
  pollLimitMs?: number
  now?: () => number
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}
export function waitForRun(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
}
async function pollQueuedRun(options: FollowOptions, signal: AbortSignal): Promise<void> {
  const { db, gateway, sink, context } = options
  while (!signal.aborted && readRun(db.sqlite, context.runId).status === 'queued') {
    await (options.wait ?? waitForRun)(options.pollIntervalMs ?? 2000, signal)
    if (signal.aborted) return
    try {
      const run = await gateway.getRun(
        context.profile,
        context.runId,
        context.credentialGeneration,
        signal,
      )
      if (runLifecycle.isTerminal(run.status)) return
      if (run.status !== 'queued') {
        const observation = runStatusObservation(context, run)
        await sink.submit({
          ...observation,
          apply(ctx) {
            // SSE may already have progressed while the status request was in flight.
            return readRun(ctx.sqlite, context.runId).status === 'queued'
              ? observation.apply(ctx)
              : []
          },
        })
        return
      }
    } catch (error) {
      if (signal.aborted || error instanceof CredentialsUnavailable) return
      if (!(error instanceof HermesHttpError)) throw error
    }
  }
}

const isRunGone = (error: HermesHttpError) => error.status === 404 && error.code === 'run_not_found'

export async function followRun(options: FollowOptions): Promise<void> {
  const { db, gateway, sink, context, signal } = options
  const initial = readRun(db.sqlite, context.runId)
  if (runLifecycle.isTerminal(initial.status) || signal?.aborted) return
  const now = options.now ?? Date.now
  const wait = options.wait ?? waitForRun
  let reason = 'SSE retries exhausted'
  try {
    // Runs API has no queued/started event. Reconcile dispatch with current status first.
    const status = await gateway.getRun(
      context.profile,
      context.runId,
      context.credentialGeneration,
      signal,
    )
    // A fast finished run can still have a retained replay. Do not seal its tools before reading it.
    if (!runLifecycle.isTerminal(status.status))
      await sink.submit(runStatusObservation(context, status))
  } catch (error) {
    if (signal?.aborted) return
    if (error instanceof CredentialsUnavailable) throw error
    if (!(error instanceof HermesHttpError)) throw error
    if (isRunGone(error)) {
      await sink.submit(runLostObservation(context))
      return
    }
  }
  const source = `run-sse:${context.profile}`
  const recordGap = async (why: string, tag: string) => {
    const from = readRun(db.sqlite, context.runId).updated_at
    const to = new Date(now()).toISOString()
    await sink.submit({
      source,
      identity: `gap:${context.runId}:${initial.last_seq ?? 'none'}:${tag}:${to}`,
      apply({ sqlite }) {
        sqlite
          .prepare(
            'INSERT INTO gaps (source, run_id, from_ts, to_ts, reason) VALUES (?, ?, ?, ?, ?)',
          )
          .run(source, context.runId, from, to, why)
        return [
          { type: 'gap.recorded', data: { source, runId: context.runId, from, to, reason: why } },
          runDraft(sqlite, context.runId),
        ]
      },
    })
  }
  const queuedController = new AbortController()
  const queuedSignal = signal
    ? AbortSignal.any([signal, queuedController.signal])
    : queuedController.signal
  const queuedPolling = pollQueuedRun(options, queuedSignal)
  // Attach a handler immediately; an ingest failure is surfaced when SSE exits.
  void queuedPolling.catch(() => {})
  try {
    const result = await resumableSse({
      connect: (lastEventId) =>
        gateway.runEvents(
          context.profile,
          context.runId,
          lastEventId,
          context.credentialGeneration,
          signal,
        ),
      onEvent: async (event) => {
        const value: unknown = JSON.parse(event.data)
        const seq = z.object({ seq: z.int().nonnegative() }).parse(value).seq
        if (event.id !== String(seq)) throw new Error('SSE ID does not match event sequence')
        await sink.submit(translateRunEvent(context, value, options.metrics))
      },
      // Hermes sends the retained events right after the notice (api_server_runs `_write_event` loop), so
      // keep reading: record the gap and let the stream deliver what is left, including a pending approval.
      onTruncated: async (truncated) => {
        await recordGap(
          `SSE replay truncated (oldest retained ${truncated.oldestRetainedSeq})`,
          `truncated:${truncated.oldestRetainedSeq}`,
        )
      },
      ...(initial.last_seq === null ? {} : { lastEventId: String(initial.last_seq) }),
      ...(signal ? { signal } : {}),
      ...(options.backoff ? { backoff: options.backoff } : {}),
    })
    if (result.ended === 'aborted') return
    if (
      result.ended === 'server_closed' &&
      runLifecycle.isTerminal(readRun(db.sqlite, context.runId).status)
    )
      return
    if (result.ended === 'server_closed') reason = 'SSE closed without terminal status'
  } catch (error) {
    if (signal?.aborted) return
    if (error instanceof SseHttpError) reason = `SSE unavailable (HTTP ${error.status})`
    else throw error
  } finally {
    queuedController.abort()
    await queuedPolling
  }
  if (signal?.aborted) return
  await recordGap(reason, 'end')
  const deadline = now() + (options.pollLimitMs ?? 30 * 60 * 1000)
  while (!signal?.aborted && now() < deadline) {
    try {
      const run = await gateway.getRun(
        context.profile,
        context.runId,
        context.credentialGeneration,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - now()))])
          : AbortSignal.timeout(Math.max(1, deadline - now())),
      )
      // A pending approval is not on the status-polling path otherwise: surface it so someone is asked.
      const pending = statusApprovalObservation(context, run)
      if (pending) await sink.submit(pending)
      // Only the terminal reconciliation is immutable by status; interim waiting cycles can repeat.
      if (runLifecycle.isTerminal(run.status)) {
        await sink.submit(runStatusObservation(context, run))
        return
      }
    } catch (error) {
      if (signal?.aborted) return
      if (!(error instanceof HermesHttpError)) throw error
      if (isRunGone(error)) {
        await sink.submit(runLostObservation(context))
        return
      }
    }
    await wait(Math.min(options.pollIntervalMs ?? 2000, Math.max(0, deadline - now())), signal)
  }
  if (!signal?.aborted) throw new Error('Run status polling timed out')
}
