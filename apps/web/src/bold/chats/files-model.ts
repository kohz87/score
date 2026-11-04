import type { JobResults } from '@score/contract'
import type { WorkbenchTab } from '../bold-links.ts'

/** One line of Info's Files and results (3.25.0): a file, a draft, a screen or a link a topic produced. */
export type FileRow = {
  key: string
  kind: 'file' | 'draft' | 'screen' | 'link'
  name: string
  title: string
  /** The agents that made it (ids), in order. */
  by: string[]
  at: string
  tab: WorkbenchTab
  file?: string
}

/** How many rows Info shows before "Show all (N)". */
export const FILE_ROWS_SHOWN = 6

function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function linkName(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The rows of one topic's results, newest first. A file changed by several cards is one row. */
export function fileRows(
  results: JobResults | undefined,
  screenName: (agentId: string) => string,
): FileRow[] {
  if (!results) return []
  const rows = new Map<string, FileRow>()
  for (const card of results.items) {
    if (card.kind === 'change') {
      for (const file of card.files) {
        const key = `code:${file.path}`
        const seen = rows.get(key)
        if (seen) {
          if (card.at > seen.at) seen.at = card.at
          seen.by = [...new Set([...seen.by, ...file.by])]
        } else
          rows.set(key, {
            key,
            kind: 'file',
            name: baseName(file.path),
            title: file.path,
            by: [...file.by],
            at: card.at,
            tab: 'code',
            file: file.path,
          })
      }
    } else if (card.kind === 'draft') {
      rows.set(`draft:${card.id}`, {
        key: `draft:${card.id}`,
        kind: 'draft',
        name: card.title,
        title: card.title,
        by: [card.agentId],
        at: card.at,
        tab: 'draft',
      })
    } else {
      const name = card.title ?? linkName(card.url)
      rows.set(`link:${card.id}`, {
        key: `link:${card.id}`,
        kind: 'link',
        name,
        title: card.url,
        by: [card.agentId],
        at: card.at,
        tab: 'screen',
      })
    }
  }
  for (const screen of results.screens) {
    const key = `screen:${screen.agentId}`
    rows.set(key, {
      key,
      kind: 'screen',
      name: screenName(screen.agentId),
      title: screen.caption,
      by: [screen.agentId],
      at: screen.at,
      tab: 'screen',
    })
  }
  return [...rows.values()].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
}

/** The address that opens the viewer sheet on a row: the current address plus the topic, the tab and the file. */
export function viewerLink(
  search: string,
  jobId: string,
  tab: WorkbenchTab,
  file?: string,
): string {
  const params = new URLSearchParams(search)
  params.set('job', jobId)
  params.set('work', tab)
  if (file) params.set('file', file)
  else params.delete('file')
  return `/b?${params.toString()}`
}

/** The address that closes the viewer sheet, leaving everything else as it was. */
export function viewerClosedSearch(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('work')
  next.delete('file')
  return next
}

/** The `?work=` values that open the viewer sheet (`graph` and `results` open Info's tabs instead). */
export const VIEWER_WORK = ['workbench', 'code', 'screen', 'draft'] as const
export function isViewerWork(work: string | null): boolean {
  return work !== null && (VIEWER_WORK as readonly string[]).includes(work)
}
