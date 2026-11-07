export const PHONE = '(max-width: 860px)'

export type View = 'room' | 'agents' | 'knowledge' | 'tasks' | 'screens' | 'settings'

export function viewOf(path: string): View {
  if (path.startsWith('/b/agents')) return 'agents'
  if (path.startsWith('/b/knowledge')) return 'knowledge'
  if (path.startsWith('/b/settings')) return 'settings'
  if (path.startsWith('/b/tasks')) return 'tasks'
  if (path.startsWith('/b/screen')) return 'screens'
  return 'room'
}
