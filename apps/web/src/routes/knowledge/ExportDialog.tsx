import { useQuery } from '@tanstack/react-query'
import type { KnowledgeExportRequest } from '@score/contract'
import { Modal } from './KnowledgeDialogs.tsx'
import { fetchExportSummary } from './knowledge-export.ts'
import { formatBytes } from './knowledge-files.ts'
import { knowledgeFailure } from './knowledge-queries.ts'

/** Shows what an export holds (file count, size) before the download starts. */
export function ExportDialog({
  request,
  heading,
  busy,
  onExport,
  onClose,
}: {
  request: KnowledgeExportRequest
  heading: string
  busy: boolean
  onExport: () => void
  onClose: () => void
}) {
  const summary = useQuery({
    queryKey: ['knowledge', 'export-summary', request],
    queryFn: () => fetchExportSummary(request),
    retry: false,
    gcTime: 0,
  })
  return (
    <Modal title={heading} onClose={onClose}>
      {summary.isPending && <p role="status">Counting files…</p>}
      {summary.isError && <p role="alert">{knowledgeFailure(summary.error, 'export')}</p>}
      {summary.data && (
        <p role="status">
          {summary.data.files} {summary.data.files === 1 ? 'file' : 'files'},{' '}
          {formatBytes(summary.data.bytes)} before compression. Notes and documents come out as they
          are stored, in folders, in one zip file.
        </p>
      )}
      <div className="kn-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="kn-primary"
          disabled={busy || !summary.data}
          onClick={onExport}
        >
          {busy ? 'Preparing…' : 'Download zip'}
        </button>
      </div>
    </Modal>
  )
}
