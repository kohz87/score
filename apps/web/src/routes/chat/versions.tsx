import { RoomVersionDetailSchema, type AgentSummary, type RoomVersion } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { MessageItem } from './MessageItem.tsx'
import { startEdit } from './message-edit.ts'

/** A hidden version's messages, read-only (PLAN 5.33). */
function PreviousVersion({ version, agents }: { version: RoomVersion; agents: AgentSummary[] }) {
  const detail = useQuery({
    queryKey: ['chat', 'version', version.roomId, version.anchorId],
    queryFn: async () =>
      RoomVersionDetailSchema.parse(
        await apiFetch(
          `rooms/${encodeURIComponent(version.roomId)}/versions/${encodeURIComponent(version.anchorId)}`,
        ),
      ),
    staleTime: Infinity,
  })
  return (
    <div className="chat-previous" role="region" aria-label="Previous version">
      <p className="chat-previous-note">
        Previous version, read-only. {version.hiddenCount} hidden{' '}
        {version.hiddenCount === 1 ? 'message' : 'messages'}.
        {version.skipped.length > 0 && ' Agents were not rewound, so they may still remember it.'}
      </p>
      {detail.isPending && <p role="status">Loading…</p>}
      {detail.isError && <p role="alert">Could not load that version.</p>}
      {detail.data?.items.map((message) => (
        <MessageItem key={message.id} message={message} agents={agents} readOnly />
      ))}
    </div>
  )
}

/**
 * The compact "Version 2 of 2 ‹ ›" switcher (PLAN 5.33). For an edit it sits above the correction; for a delete it
 * stands where the deleted message was and says "Previous version".
 */
export function VersionSwitcher({
  version,
  versions,
  agents,
}: {
  version: RoomVersion
  versions: RoomVersion[]
  agents: AgentSummary[]
}) {
  // Which hidden version is on screen; null = the live conversation.
  const [viewing, setViewing] = useState<RoomVersion | null>(null)
  const isDelete = version.mode === 'delete'
  // An edit whose rewind is done but whose correction was never sent: the original is hidden with no replacement yet.
  const open = version.mode === 'edit' && version.replacedBy === null
  const [continuing, setContinuing] = useState(false)
  async function continueEditing() {
    setContinuing(true)
    try {
      const detail = RoomVersionDetailSchema.parse(
        await apiFetch(
          `rooms/${encodeURIComponent(version.roomId)}/versions/${encodeURIComponent(version.anchorId)}`,
        ),
      )
      const anchor = detail.items.find((message) => message.id === version.anchorId)
      // The rewind already happened: sending posts the correction without asking for it again.
      if (anchor) startEdit(anchor, { rewound: true })
    } finally {
      setContinuing(false)
    }
  }
  const older = viewing ? versions.find((item) => item.replacedBy === viewing.anchorId) : version
  const newer = viewing
    ? (versions.find((item) => item.anchorId === viewing.replacedBy) ?? null)
    : null
  const shown = viewing ?? version
  return (
    <div className="chat-version" data-testid="version-switcher">
      <div className="chat-version-bar">
        {isDelete || open ? (
          <>
            <span>{open ? 'Edit not sent yet: the original is hidden' : 'Previous version'}</span>
            <button
              type="button"
              className="chat-version-toggle"
              aria-expanded={viewing !== null}
              onClick={() => setViewing(viewing ? null : version)}
            >
              {viewing ? 'Hide' : 'View'}
            </button>
            {open && (
              <button
                type="button"
                className="chat-version-toggle"
                disabled={continuing}
                onClick={() => void continueEditing()}
              >
                Continue editing
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="chat-version-step"
              aria-label="Previous version"
              disabled={!older}
              onClick={() => older && setViewing(older)}
            >
              ‹
            </button>
            <span aria-live="polite">
              Version {viewing ? shown.number : shown.count} of {shown.count}
            </span>
            <button
              type="button"
              className="chat-version-step"
              aria-label="Next version"
              disabled={!viewing}
              onClick={() => setViewing(newer)}
            >
              ›
            </button>
          </>
        )}
      </div>
      {viewing && <PreviousVersion version={viewing} agents={agents} />}
    </div>
  )
}
