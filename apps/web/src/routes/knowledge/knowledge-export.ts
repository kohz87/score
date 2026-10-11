import {
  ErrorEnvelopeSchema,
  KnowledgeExportSummarySchema,
  type KnowledgeExportRequest,
} from '@score/contract'
import { useCallback, useState } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { knowledgeFailure } from './knowledge-queries.ts'
import { notePath } from './knowledge-paths.ts'

// Client side of Knowledge export (PLAN 6.7, contract §12).

export const noteDownloadHref = (path: string) =>
  `/api/knowledge/notes/${notePath(path)}?download=1`

export async function fetchExportSummary(request: KnowledgeExportRequest) {
  return KnowledgeExportSummarySchema.parse(
    await apiFetch('knowledge/export/summary', { method: 'POST', body: JSON.stringify(request) }),
  )
}

function fileNameOf(header: string | null): string {
  const match = /filename="([^"]+)"/.exec(header ?? '')
  return match?.[1] ?? 'knowledge-export.zip'
}

/** Resolves when the archive has been handed to the browser's download. */
export async function downloadExport(request: KnowledgeExportRequest): Promise<void> {
  const response = await fetch('/api/knowledge/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'X-Score-Client': 'web' },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
    throw new ApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'request_failed',
      parsed.success ? parsed.data.error.message : 'The export failed. Try again.',
      parsed.success ? parsed.data.error.details : undefined,
    )
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileNameOf(response.headers.get('content-disposition'))
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** One export at a time; `busy` is true from the click until the download starts ("Preparing…"). */
export function useExport(onError: (message: string) => void) {
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (request: KnowledgeExportRequest): Promise<boolean> => {
      setBusy(true)
      try {
        await downloadExport(request)
        return true
      } catch (error) {
        onError(knowledgeFailure(error, 'export'))
        return false
      } finally {
        setBusy(false)
      }
    },
    [onError],
  )
  return { busy, run }
}
