export type NotificationKind = 'approvals' | 'routines' | 'errors' | 'replies'
export const notificationKinds: { kind: NotificationKind; label: string; hint: string }[] = [
  {
    kind: 'approvals',
    label: 'An approval is waiting for me',
    hint: 'An agent needs a yes or no.',
  },
  {
    kind: 'routines',
    label: 'A routine finished',
    hint: 'A scheduled routine completed or failed.',
  },
  { kind: 'errors', label: 'An agent hit an error', hint: 'A run failed.' },
  {
    kind: 'replies',
    label: 'An agent replied to me',
    hint: 'Only while Score is in the background.',
  },
]

export interface NotificationPrefs {
  /** This device opted in (and the browser permission was granted on a click). */
  enabled: boolean
  kinds: Record<NotificationKind, boolean>
  /** Message text and approval titles appear in notifications only when this is on. */
  previews: boolean
}

const STORAGE_KEY = 'score.notifications'
export const defaultNotificationPrefs = (): NotificationPrefs => ({
  enabled: false,
  kinds: { approvals: true, routines: true, errors: true, replies: true },
  previews: false,
})

export function readNotificationPrefs(): NotificationPrefs {
  const prefs = defaultNotificationPrefs()
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return prefs
    const value = stored as Partial<NotificationPrefs>
    prefs.enabled = value.enabled === true
    prefs.previews = value.previews === true
    for (const { kind } of notificationKinds)
      if (typeof value.kinds?.[kind] === 'boolean') prefs.kinds[kind] = value.kinds[kind]
  } catch {
    // Blocked or damaged storage: the defaults (off) apply.
  }
  return prefs
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Without storage the choice lasts until the page closes.
  }
  window.dispatchEvent(new Event('score:notification-prefs'))
}
