import { useContext, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { StreamContext } from '../data/query-client.ts'
import { agentsQuery } from '../routes/team/team-queries.ts'
import { readNotificationPrefs } from './prefs.ts'
import { createNotificationRouter } from './router.ts'
import { showNotification } from './deliver.ts'

/** Safe in-app targets only: a path on this origin. */
export const isAppPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')

function Bridge() {
  const context = useContext(StreamContext)!
  const navigate = useNavigate()
  useEffect(() => {
    const router = createNotificationRouter({
      prefs: readNotificationPrefs,
      hidden: () => document.visibilityState === 'hidden' || !document.hasFocus(),
      nameOf: (id) =>
        context.queries
          .register(agentsQuery)
          .getSnapshot()
          .data?.find((agent) => agent.id === id)?.name ?? id,
    })
    const open = (url: string) => {
      // Notification targets are app paths; React Router opens them in the current shell.
      if (isAppPath(url)) void navigate(url)
    }
    const unsubscribe = context.client.subscribe((event) => {
      const payload = router.handle(event)
      if (payload) void showNotification(payload, open)
    })
    // The service worker asks an open window to go to the page of a clicked notification.
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'score:navigate'
      )
        open((data as { url?: unknown }).url as string)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      unsubscribe()
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [context, navigate])
  return null
}

/** Delivers this device's notifications from the live stream while Score is open in any tab or app window. */
export function NotificationBridge() {
  // Some trees (tests) have no stream; nothing to deliver there.
  if (!useContext(StreamContext)) return null
  return <Bridge />
}
