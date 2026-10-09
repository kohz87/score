import { Link } from 'react-router'
import { useAllShares, useRevokeShare } from '../../data/shares.ts'

export function SharesSection() {
  const shares = useAllShares()
  const revoke = useRevokeShare()
  return (
    <section id="shares" className="settings-card" aria-labelledby="settings-shares">
      <h2 id="settings-shares">Shares</h2>
      <p>
        Links to frozen, read-only copies of rooms. Anyone with a link who can reach this Score can
        read its snapshot until it expires or you revoke it. Make one from a room&apos;s menu in{' '}
        <Link to="/chat">Chat</Link>.
      </p>
      {shares.isError && <p role="alert">Could not load the share links.</p>}
      {shares.data?.length === 0 && <p className="settings-muted">No share links.</p>}
      {shares.data && shares.data.length > 0 && (
        <ul className="settings-rows" aria-label="Share links">
          {shares.data.map((share) => (
            <li key={share.id} className="settings-row">
              <span className="settings-row-name">{share.roomName}</span>
              <span className="settings-detail">
                created {new Date(share.createdAt).toLocaleString()},{' '}
                {share.status === 'expired' ? 'expired' : 'expires'}{' '}
                {new Date(share.expiresAt).toLocaleString()}, {share.views}{' '}
                {share.views === 1 ? 'view' : 'views'}
                {share.includeImages ? ', with images' : ''}
                {share.roomChanged ? ', room changed since (the link shows the old version)' : ''}
              </span>
              <button
                type="button"
                className="settings-pill"
                aria-label={`Revoke the link to ${share.roomName} created ${new Date(share.createdAt).toLocaleString()}`}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(share.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoke.isError && <p role="alert">Could not revoke that link.</p>}
    </section>
  )
}
