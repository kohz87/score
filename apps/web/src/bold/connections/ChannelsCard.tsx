import { useState } from 'react'
import type { MessagingPlatform } from '@score/contract'
import { MessagingSetup } from '../../routes/settings/MessagingSetup.tsx'
import { focusSoon, RemoveConfirm } from '../RemoveConfirm.tsx'
import {
  useConnections,
  useMessagingFields,
  useRecheckSettings,
  useRemoveConnection,
} from '../../routes/settings/settings-queries.ts'

function readable(detail: string | null): string {
  if (!detail) return ''
  if (!/^[a-z0-9_]+$/.test(detail)) return detail
  const words = detail.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Disconnect for a platform that is set up in the browser; others are cleared from the terminal. */
function ChannelRemove({ row }: { row: MessagingPlatform }) {
  const [open, setOpen] = useState(false)
  const fields = useMessagingFields(row.platform, row.status === 'connected' || Boolean(row.detail))
  const { removeMessaging } = useRemoveConnection()
  if (fields.data?.browserSetup !== true) return null
  return (
    <>
      <button
        type="button"
        className="btn sm ghost"
        id={`remove-channel-${row.platform}`}
        aria-label={`${row.status === 'connected' ? 'Disconnect' : 'Remove'} ${row.label}`}
        aria-expanded={open}
        onClick={() => {
          removeMessaging.reset()
          setOpen((now) => !now)
        }}
      >
        {row.status === 'connected' ? 'Disconnect' : 'Remove'}
      </button>
      {open && (
        <RemoveConfirm
          what={row.label}
          text={`Clears ${row.label}’s settings. It disconnects when the gateway restarts.`}
          pending={removeMessaging.isPending}
          error={removeMessaging.error}
          onCancel={() => {
            setOpen(false)
            focusSoon(`remove-channel-${row.platform}`)
          }}
          onRemove={() =>
            removeMessaging.mutate(row.platform, {
              onSuccess: () => {
                setOpen(false)
                focusSoon('bold-channels-title')
              },
            })
          }
        />
      )}
    </>
  )
}

export function ChannelsCard() {
  const [setup, setSetup] = useState<string | null>(null)
  const connections = useConnections()
  const recheck = useRecheckSettings()
  return (
    <section className="card" aria-labelledby="bold-channels-title">
      <h3 id="bold-channels-title" tabIndex={-1}>
        Channels
      </h3>
      <span className="small muted">
        Talk to the team room from other apps; replies land in the room.
      </span>
      {connections.isPending && <p role="status">Loading channels…</p>}
      {connections.isError && <p role="alert">Couldn’t load channels. Try again later.</p>}
      <div className="bold-connect-list">
        {connections.data?.messaging.map((row) => (
          <div key={row.platform} className="bold-connect-row" data-channel={row.platform}>
            <span
              className="dot"
              data-status={row.status === 'connected' ? 'ok' : 'off'}
              aria-hidden="true"
            />
            <span className="grow bold-connect-name" data-missing={row.status !== 'connected'}>
              {row.label}
            </span>
            <span className="small muted">
              {row.status === 'connected' ? 'Connected' : readable(row.detail) || 'Not connected'}
            </span>
            {row.status !== 'connected' && (
              <button
                type="button"
                className="btn sm"
                aria-label={`Connect ${row.label}`}
                aria-expanded={setup === row.platform}
                onClick={() => setSetup(row.platform)}
              >
                Connect
              </button>
            )}
            <ChannelRemove row={row} />
            {setup === row.platform && (
              <div className="bold-connect-panel" data-protected="block">
                <MessagingSetup
                  platform={row.platform}
                  label={row.label}
                  terminalCommand="hermes gateway setup"
                  onSaved={recheck}
                  onClose={() => {
                    setSetup(null)
                    recheck()
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <span className="small muted">
        Sign-in tokens are kept by Hermes in its own settings, never by Score.
      </span>
    </section>
  )
}
