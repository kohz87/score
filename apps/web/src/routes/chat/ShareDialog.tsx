import type { Room, ShareSummary } from '@score/contract'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { copyText, selectText } from '../../data/clipboard.ts'
import { shareFailure, useCreateShare, useRevokeShare, useRoomShares } from '../../data/shares.ts'
import { roomLabel } from './room-label.ts'

const EXPIRY = [
  { days: 1, label: '1 day' },
  { days: 3, label: '3 days' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
]

export function ShareList({
  items,
  onRevoke,
}: {
  items: ShareSummary[]
  onRevoke: (share: ShareSummary) => void
}) {
  return (
    <ul className="share-list" aria-label="Active share links">
      {items.map((share) => (
        <li key={share.id}>
          <span>
            Created {new Date(share.createdAt).toLocaleString()} ·{' '}
            {share.status === 'expired' ? 'expired' : 'expires'}{' '}
            {new Date(share.expiresAt).toLocaleString()} · {share.views}{' '}
            {share.views === 1 ? 'view' : 'views'}
            {share.includeImages ? ' · with images' : ''}
          </span>
          <button type="button" onClick={() => onRevoke(share)}>
            Revoke
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Share a frozen copy of one room as a link (PLAN 5.26). Needs the security password; the link opens a read-only,
 * text-only page for anyone who can reach this Score.
 */
export function ShareDialog({ room, close }: { room: Room; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const link = useRef<HTMLElement>(null)
  const [password, setPassword] = useState('')
  const [days, setDays] = useState(7)
  const [images, setImages] = useState(false)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
  const shares = useRoomShares(room.id)
  const create = useCreateShare(room.id)
  const revoke = useRevokeShare()
  useEffect(() => {
    dialog.current?.showModal?.()
    // The password lives only in this dialog.
    return () => setPassword('')
  }, [])
  function submit(event: FormEvent) {
    event.preventDefault()
    setCopied('idle')
    create.mutate(
      { password, expiresInDays: days, includeImages: images },
      { onSettled: () => setPassword('') },
    )
  }
  const result = create.data
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="share-dialog"
      aria-labelledby="share-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="share-heading">
        <h2 id="share-title">Share {roomLabel(room)}</h2>
        <button type="button" className="chat-small-button" onClick={close}>
          Close
        </button>
      </div>
      <p>
        This makes a link to a frozen, read-only copy of the room’s messages as they are now. Only
        the text is shared (secrets are hidden); tool output, files, plans and reasoning are left
        out. Anyone who has the link <strong>and can reach this Score</strong> (your LAN or
        Tailscale) can read it until it expires or you revoke it.
      </p>
      <form className="share-form" onSubmit={submit}>
        <label>
          Security password
          <input
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          Link works for
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {EXPIRY.map((option) => (
              <option key={option.days} value={option.days}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="share-check">
          <input
            type="checkbox"
            checked={images}
            onChange={(event) => setImages(event.target.checked)}
          />
          Include the images attached in this room
        </label>
        <button
          type="submit"
          className="share-primary"
          disabled={create.isPending || password.length < 8}
        >
          {create.isPending ? 'Creating…' : 'Create link'}
        </button>
      </form>
      {create.error && <p role="alert">{shareFailure(create.error)}</p>}
      {result && (
        <div className="share-result" role="group" aria-label="New share link">
          <p>
            Copy it now: it is shown only once. It works until{' '}
            {new Date(result.expiresAt).toLocaleString()}.
          </p>
          <code ref={link} onClick={() => selectText(link.current)}>
            {result.url}
          </code>
          <button
            type="button"
            className="chat-small-button"
            onClick={async () => {
              if (await copyText(result.url)) setCopied('copied')
              else {
                selectText(link.current)
                setCopied('manual')
              }
            }}
          >
            {copied === 'copied' ? 'Copied' : 'Copy link'}
          </button>
          {copied === 'manual' && (
            <p role="status">The link is selected: press Ctrl+C (or ⌘C) to copy it.</p>
          )}
        </div>
      )}
      <h3>Active links for this room</h3>
      {shares.data && shares.data.length === 0 && <p className="share-empty">None.</p>}
      {shares.data && shares.data.length > 0 && (
        <ShareList items={shares.data} onRevoke={(share) => revoke.mutate(share.id)} />
      )}
      {shares.isError && <p role="alert">Couldn’t load the active links.</p>}
      {revoke.isError && <p role="alert">Couldn’t revoke that link.</p>}
    </dialog>
  )
}
