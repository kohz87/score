import type { LookView } from '../../themes/layout.ts'

// The pages the preview can show: the real routes of the app, read-only.
export type PreviewPage = { id: string; label: string; path: string; view: LookView }

export const previewPages: PreviewPage[] = [
  { id: 'now', label: 'Now', path: '/now', view: 'admin' },
  { id: 'chat', label: 'Chat', path: '/chat', view: 'admin' },
  { id: 'tasks', label: 'Tasks', path: '/tasks', view: 'admin' },
  { id: 'team', label: 'Team', path: '/team', view: 'admin' },
  { id: 'knowledge', label: 'Knowledge', path: '/knowledge', view: 'admin' },
  { id: 'reports', label: 'Reports', path: '/reports', view: 'admin' },
  { id: 'settings', label: 'Settings', path: '/settings', view: 'admin' },
  { id: 'user', label: 'Chat-first view', path: '/u', view: 'user' },
]

export type PreviewDevice = { id: 'desktop' | 'tablet' | 'phone'; label: string; width: number }
export const previewDevices: PreviewDevice[] = [
  { id: 'desktop', label: 'Desktop', width: 1280 },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'phone', label: 'Phone', width: 390 },
]
