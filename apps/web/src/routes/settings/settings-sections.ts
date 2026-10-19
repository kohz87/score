import { useLocation } from 'react-router'
import { remoteTransport } from '../../data/session.ts'
import { useSecurityStatus } from './settings-queries.ts'

// Settings is one page per section (PLAN 10.1): `/settings/<id>`. The ids are also the old `/settings#<id>` anchors.
export const settingsSections = [
  { id: 'models', label: 'Models and keys' },
  { id: 'connections', label: 'Connections' },
  { id: 'rules', label: 'Rules and approvals' },
  { id: 'look', label: 'Look' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'shares', label: 'Shares' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'backup', label: 'Backup' },
  { id: 'logs', label: 'Logs' },
  { id: 'about', label: 'About' },
] as const

export type SettingsSection = { id: string; label: string }

export const remoteSection: SettingsSection = { id: 'remote-access', label: 'Remote access' }
export const terminalSection: SettingsSection = { id: 'terminal', label: 'Terminal' }
export const firstSection = settingsSections[0]

export function settingsPath(id: string): string {
  return `/settings/${id}`
}

/**
 * Every section this browser shows: Remote access on the remote (HTTPS) transport, Terminal when the web terminal is
 * on. `terminalPending` is true while that is still being read, so a deep link to /settings/terminal can wait.
 */
export function useSettingsSections(skipStatus = false): {
  sections: SettingsSection[]
  terminalPending: boolean
} {
  // The pairing page makes no request but its own.
  const pairing = useLocation().pathname.startsWith('/pair')
  const security = useSecurityStatus(!pairing && !skipStatus)
  const sections: SettingsSection[] = [...settingsSections]
  if (remoteTransport()) sections.push(remoteSection)
  if (security.data?.terminal === true) sections.push(terminalSection)
  return { sections, terminalPending: !pairing && !skipStatus && security.isPending }
}
