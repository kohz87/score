import type { NotificationPayload } from './router.ts'

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

/** Must be called from a click: browsers refuse (or ignore) permission prompts that no gesture asked for. */
export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (!notificationsSupported()) return 'unsupported'
  return Notification.requestPermission()
}

/**
 * Shows one notification. The service worker shows it when there is one (phones only allow that, and its click handler
 * can open the page); otherwise the page does, and a click focuses the window and goes to the page.
 */
export async function showNotification(
  payload: NotificationPayload,
  open: (url: string) => void,
): Promise<void> {
  if (notificationPermission() !== 'granted') return
  const options = {
    body: payload.body,
    tag: payload.tag,
    icon: '/icon-192.png',
    data: { url: payload.url },
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration) {
      await registration.showNotification(payload.title, options)
      return
    }
  } catch {
    // Fall through to the page's own notification.
  }
  const notification = new Notification(payload.title, options)
  notification.onclick = () => {
    window.focus()
    open(payload.url)
    notification.close()
  }
}
