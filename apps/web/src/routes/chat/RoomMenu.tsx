import type { Room, RoomProject } from '@score/contract'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { parseTagInput, patchRoom, regenerateSummary } from './conversation-api.ts'
import { RenameRoom } from './RenameRoom.tsx'
import { baseName } from './room-groups.ts'
import { setShowDeleted, useShowDeleted } from './deleted-toggle.ts'

type Panel = 'main' | 'project' | 'tags' | 'summary' | 'rename'

/**
 * The "⋯" menu of a room in the list (PLAN 5.26): pin, archive, project, tags, export and share. A menu button
 * pattern: arrow keys move between items, Escape closes and returns focus to the button.
 */
export function RoomMenu({
  room,
  projects,
  onShare,
  onDelete,
}: {
  room: Room
  projects: RoomProject[]
  onShare?: ((room: Room) => void) | undefined
  onDelete?: ((room: Room) => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<Panel>('main')
  const [error, setError] = useState<string | null>(null)
  const [tagText, setTagText] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const label = baseName(room.name)
  const showDeleted = useShowDeleted(room.id)
  const summary = room.autoSummary ?? { enabled: false, thresholdTokens: 12000 }

  useEffect(() => {
    if (!open) return
    // Focus the first control of whichever panel is showing.
    root.current?.querySelector<HTMLElement>('[role="menuitem"], select, input')?.focus()
  }, [open, panel])

  function close(restoreFocus = true) {
    setOpen(false)
    setPanel('main')
    setError(null)
    if (restoreFocus) button.current?.focus()
  }
  async function run(body: Parameters<typeof patchRoom>[1]) {
    try {
      await patchRoom(room.id, body)
      close()
    } catch {
      setError('Could not save that. Please try again.')
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [
      ...(root.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ) ?? []),
    ]
    if (!items.length) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1
    items[(next + items.length) % items.length]!.focus()
  }

  return (
    <div
      className="chat-room-menu"
      ref={root}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget)) close(false)
      }}
    >
      <button
        ref={button}
        type="button"
        className="chat-room-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${label}`}
        onClick={() => {
          setTagText((room.tags ?? []).join(' '))
          setOpen((value) => !value)
          setPanel('main')
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="chat-menu" id={menuId} role="menu" aria-label={`${label} actions`}>
          {panel === 'main' && (
            <>
              <button type="button" role="menuitem" onClick={() => setPanel('rename')}>
                Rename…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void run({ pinned: !room.pinned })}
              >
                {room.pinned ? 'Unpin' : 'Pin to top'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void run({ archived: !room.archived })}
              >
                {room.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button type="button" role="menuitem" onClick={() => setPanel('project')}>
                Move to project…
              </button>
              <button type="button" role="menuitem" onClick={() => setPanel('tags')}>
                Edit tags…
              </button>
              <button type="button" role="menuitem" onClick={() => setPanel('summary')}>
                Summaries…
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={showDeleted}
                onClick={() => {
                  setShowDeleted(room.id, !showDeleted)
                  close()
                }}
              >
                {showDeleted ? 'Hide deleted messages' : 'Show deleted messages'}
              </button>
              <a
                role="menuitem"
                href={`/api/rooms/${encodeURIComponent(room.id)}/export.md`}
                download
                onClick={() => close(false)}
              >
                Export as Markdown
              </a>
              <a
                role="menuitem"
                href={`/api/rooms/${encodeURIComponent(room.id)}/export.json`}
                download
                onClick={() => close(false)}
              >
                Export as JSON
              </a>
              {onDelete && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close(false)
                    onDelete(room)
                  }}
                >
                  Delete room…
                </button>
              )}
              {onShare && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close(false)
                    onShare(room)
                  }}
                >
                  Share…
                </button>
              )}
            </>
          )}
          {panel === 'rename' && (
            <RenameRoom
              room={room}
              onDone={() => close()}
              onCancel={() => {
                setPanel('main')
              }}
            />
          )}
          {panel === 'project' && (
            <label className="chat-menu-field">
              Project
              <select
                value={room.projectId ?? ''}
                onChange={(event) => void run({ projectId: event.target.value || null })}
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {panel === 'tags' && (
            <form
              className="chat-menu-field"
              onSubmit={(event) => {
                event.preventDefault()
                void run({ tags: parseTagInput(tagText) })
              }}
            >
              <label>
                Tags (words, separated by spaces)
                <input
                  value={tagText}
                  maxLength={200}
                  onChange={(e) => setTagText(e.target.value)}
                />
              </label>
              <div className="chat-menu-actions">
                <button type="submit">Save</button>
                <button type="button" onClick={() => void run({ tags: null })}>
                  Use the name&apos;s #tags
                </button>
              </div>
            </form>
          )}
          {panel === 'summary' && (
            <div className="chat-menu-field">
              <label className="chat-menu-check">
                <input
                  type="checkbox"
                  checked={summary.enabled}
                  onChange={(event) =>
                    void run({ autoSummary: { ...summary, enabled: event.target.checked } })
                  }
                />
                Summarise long conversations
              </label>
              <label>
                After about (estimated tokens)
                <input
                  type="number"
                  min={2000}
                  max={200000}
                  step={1000}
                  defaultValue={summary.thresholdTokens}
                  onBlur={(event) => {
                    const value = Math.round(Number(event.target.value))
                    if (value >= 2000 && value <= 200000 && value !== summary.thresholdTokens)
                      void run({ autoSummary: { ...summary, thresholdTokens: value } })
                  }}
                />
              </label>
              <p>
                The lead agent writes it as a normal run, which costs model tokens. Tokens are
                estimated as characters divided by 4. You can edit or delete the summary in the
                thread.
              </p>
              <div className="chat-menu-actions">
                <button
                  type="button"
                  onClick={() =>
                    void regenerateSummary(room.id).then(
                      () => close(),
                      (failure: unknown) =>
                        setError(
                          failure instanceof Error ? failure.message : 'Could not start it.',
                        ),
                    )
                  }
                >
                  Summarise now
                </button>
              </div>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
