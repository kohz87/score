import { useState } from 'react'
import {
  notificationPermission,
  requestNotificationPermission,
  showNotification,
} from '../../notifications/deliver.ts'
import {
  notificationKinds,
  readNotificationPrefs,
  saveNotificationPrefs,
  type NotificationKind,
  type NotificationPrefs,
} from '../../notifications/prefs.ts'

/** Settings › Notifications: per device, so each phone or computer chooses for itself. */
export function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(readNotificationPrefs)
  const [permission, setPermission] = useState(notificationPermission)
  const [notice, setNotice] = useState('')
  const change = (next: NotificationPrefs) => {
    setPrefs(next)
    saveNotificationPrefs(next)
  }
  // Asking for permission is only ever done from this click.
  async function turnOn() {
    const result = await requestNotificationPermission()
    setPermission(result)
    if (result === 'granted') {
      change({ ...prefs, enabled: true })
      setNotice('')
    } else if (result === 'denied') {
      setNotice(
        'This browser blocked notifications for Score. Allow them in its site settings, then try again.',
      )
    }
  }
  const on = prefs.enabled && permission === 'granted'
  return (
    <section id="notifications" className="settings-card" aria-labelledby="settings-notifications">
      <div>
        <h2 id="settings-notifications">Notifications</h2>
        <p className="settings-muted-strong">Tell this device when the team needs you.</p>
      </div>
      {permission === 'unsupported' && (
        <p role="status">
          This browser can’t show notifications. On an iPhone or iPad, add Score to the Home Screen
          first (Share, then Add to Home Screen) and open it from there.
        </p>
      )}
      {permission !== 'unsupported' && !on && (
        <button
          type="button"
          className="settings-pill settings-start"
          onClick={() => void turnOn()}
        >
          Turn on notifications on this device
        </button>
      )}
      {on && (
        <button
          type="button"
          className="settings-pill settings-start"
          onClick={() => change({ ...prefs, enabled: false })}
        >
          Turn off notifications on this device
        </button>
      )}
      {permission === 'denied' && !notice && (
        <p role="status">Notifications are blocked for Score in this browser’s settings.</p>
      )}
      {notice && <p role="alert">{notice}</p>}
      <fieldset className="settings-origins" disabled={!on}>
        <legend>Notify me when</legend>
        {notificationKinds.map(({ kind, label, hint }) => (
          <label key={kind} className="settings-check">
            <input
              type="checkbox"
              checked={prefs.kinds[kind]}
              onChange={(event) =>
                change({
                  ...prefs,
                  kinds: {
                    ...prefs.kinds,
                    [kind satisfies NotificationKind]: event.target.checked,
                  },
                })
              }
            />{' '}
            {label} <span className="settings-muted">{hint}</span>
          </label>
        ))}
        <label className="settings-check">
          <input
            type="checkbox"
            checked={prefs.previews}
            onChange={(event) => change({ ...prefs, previews: event.target.checked })}
          />{' '}
          Show message previews{' '}
          <span className="settings-muted">
            Off by default: notifications then say who and what, never the message itself.
          </span>
        </label>
      </fieldset>
      {on && (
        <button
          type="button"
          className="settings-pill"
          onClick={() =>
            void showNotification(
              {
                kind: 'approvals',
                title: 'Score notifications work',
                body: 'This is a test. Tap it to open Score.',
                url: '/b',
                tag: 'test',
              },
              () => {},
            )
          }
        >
          Send a test notification
        </button>
      )}
      <p className="settings-muted">
        Notifications arrive while Score is open in a tab or an app window, including in the
        background. Delivery when Score is closed (push) is not available yet.
      </p>
    </section>
  )
}
