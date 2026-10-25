import type { LookView } from '../../themes/layout.ts'

// The pages the preview can show: the real routes of the app, read-only.
const previewAgentFallback = 'lead'

export type PreviewPage = { id: string; label: string; path: string; view: LookView }

export const previewPages: PreviewPage[] = [
  { id: 'chat', label: 'Chat', path: '/chat', view: 'admin' },
  { id: 'team', label: 'Team', path: '/team', view: 'admin' },
  { id: 'knowledge', label: 'Knowledge', path: '/knowledge', view: 'admin' },
  { id: 'reports', label: 'Reports', path: '/reports', view: 'admin' },
  { id: 'settings', label: 'Settings', path: '/settings', view: 'admin' },
  // PLAN 11.9d: the new look's screens (the bold shell). The agent page's id is filled in from the team (below).
  { id: 'b-room', label: 'New look: Room', path: '/b', view: 'admin' },
  { id: 'b-team', label: 'New look: Team', path: '/b/team', view: 'admin' },
  {
    id: 'b-agent',
    label: 'New look: Agent page',
    path: `/b/team/${previewAgentFallback}`,
    view: 'admin',
  },
  { id: 'b-settings', label: 'New look: Settings', path: '/b/settings', view: 'admin' },
]

/** The agent page of the first agent of the team; this id only holds until the team is read. */
export const previewAgentId = (page: PreviewPage, firstAgentId: string | null): PreviewPage =>
  page.id === 'b-agent' && firstAgentId ? { ...page, path: `/b/team/${firstAgentId}` } : page

export type PreviewDevice = { id: 'desktop' | 'tablet' | 'phone'; label: string; width: number }
export const previewDevices: PreviewDevice[] = [
  { id: 'desktop', label: 'Desktop', width: 1280 },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'phone', label: 'Phone', width: 390 },
]
