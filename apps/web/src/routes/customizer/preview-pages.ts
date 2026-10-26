import type { LookView } from '../../themes/layout.ts'

// The pages the preview can show: the real routes of the new shell, read-only.
const previewAgentFallback = 'lead'

export type PreviewPage = { id: string; label: string; path: string; view: LookView }

export const previewPages: PreviewPage[] = [
  { id: 'b-room', label: 'Team room', path: '/b', view: 'admin' },
  { id: 'b-team', label: 'Team', path: '/b/team', view: 'admin' },
  // The agent pages' ids are filled in from the team (below).
  {
    id: 'b-agent',
    label: 'Agent page',
    path: `/b/team/${previewAgentFallback}`,
    view: 'admin',
  },
  {
    id: 'b-screen',
    label: 'Agent screen',
    path: `/b/screen/${previewAgentFallback}`,
    view: 'admin',
  },
  { id: 'b-settings', label: 'Settings', path: '/b/settings', view: 'admin' },
]

/** The agent pages of the first agent of the team; the fallback id only holds until the team is read. */
export const previewAgentId = (page: PreviewPage, firstAgentId: string | null): PreviewPage => {
  if (!firstAgentId) return page
  if (page.id === 'b-agent') return { ...page, path: `/b/team/${firstAgentId}` }
  if (page.id === 'b-screen') return { ...page, path: `/b/screen/${firstAgentId}` }
  return page
}

export type PreviewDevice = { id: 'desktop' | 'tablet' | 'phone'; label: string; width: number }
export const previewDevices: PreviewDevice[] = [
  { id: 'desktop', label: 'Desktop', width: 1280 },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'phone', label: 'Phone', width: 390 },
]
