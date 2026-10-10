import { Worker } from 'node:worker_threads'
import { HttpError } from '../errors.ts'
import type { WorkerRequest, WorkerResult, ZipLimits } from './extract-types.ts'
import { MAX_TEXT_BYTES } from './doc-types.ts'

export const TEXT_TIMEOUT_MS = 20_000
export const ZIP_TIMEOUT_MS = 90_000
/** V8 heap of the extraction worker; a document that needs more is stored without text. */
export const WORKER_HEAP_MB = 512

export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 1000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxNoteBytes: 2 * 1024 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 64 * 1024,
}

const WORKER_URL = new URL('./extract-worker.ts', import.meta.url)

/**
 * Runs one request in a fresh worker thread with a heap limit and a wall-clock limit. The worker is killed on timeout
 * or error, so a hostile PDF cannot hang or exhaust the server. Resolves to the worker's result or a failure.
 */
export function runWorker(
  request: WorkerRequest,
  timeoutMs: number,
): Promise<WorkerResult | { ok: false; limit: false; message: string; timeout?: true }> {
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(WORKER_URL, {
      workerData: request,
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 64 },
      // The worker needs no environment and no stdio.
      env: {},
      stdout: true,
      stderr: true,
    })
    const finish = (value: Parameters<typeof resolve>[0]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(value)
    }
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          limit: false,
          message: 'Reading the file took too long',
          timeout: true,
        }),
      timeoutMs,
    )
    worker.once('message', (result: WorkerResult) => finish(result))
    worker.once('error', (error) =>
      finish({ ok: false, limit: false, message: error.message || 'The file could not be read' }),
    )
    worker.once('exit', (code) =>
      finish({ ok: false, limit: false, message: `The reader stopped (exit ${code})` }),
    )
  })
}

export type TextOutcome =
  { status: 'indexed' | 'truncated'; text: string } | { status: 'unavailable'; text: '' }

/** Text of a PDF, DOCX or HTML file; any failure is `unavailable` (the file is kept without text). */
export async function extractDocumentText(
  kind: 'pdf' | 'docx' | 'html',
  bytes: Uint8Array,
): Promise<TextOutcome> {
  const result = await runWorker(
    { op: 'text', kind, bytes, maxBytes: MAX_TEXT_BYTES },
    TEXT_TIMEOUT_MS,
  )
  if (!result.ok || !('text' in result)) return { status: 'unavailable', text: '' }
  return { status: result.truncated ? 'truncated' : 'indexed', text: result.text }
}

export function zipFailure(result: { ok: false; limit: boolean; message: string }): HttpError {
  return result.limit
    ? new HttpError(413, 'zip_limits', result.message)
    : new HttpError(415, 'unsupported_type', 'That zip file could not be read')
}
