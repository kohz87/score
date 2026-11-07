import type { Job, Room } from '@score/contract'
import { useId, useRef, useState } from 'react'
import { TrashIcon } from '../BoldIcons.tsx'
import { DotsIcon, moveInMenu, useMenu } from './menu-primitives.tsx'
import { useMenuPlacement } from './menu-placement.ts'

export function JobMenu({
  room,
  job,
  onShare,
  onRename,
  onCloseJob,
  onReopen,
  onDelete,
}: {
  room: Room
  job: Job | undefined
  onShare: (job: Job) => void
  onRename: (job: Job) => void
  onCloseJob: (job: Job) => void
  onReopen: (job: Job) => void
  onDelete: (job: Job) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useMenuPlacement(root, open)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = useMenu(open, setOpen, root, trigger)
  if (!job) return null
  return (
    <span className="bold-job-menu-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        aria-label="Job menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          className="menu bold-job-menu"
          id={menuId}
          role="menu"
          aria-label={`${job.title} actions`}
          data-protected="flex"
          onKeyDown={moveInMenu}
        >
          {!job.isDefault && (
            <button
              type="button"
              className="mi"
              role="menuitem"
              onClick={() => {
                close(false)
                onRename(job)
              }}
            >
              Rename…
            </button>
          )}
          {!job.isDefault && (
            <button
              type="button"
              className="mi"
              role="menuitem"
              onClick={() => {
                close(false)
                if (job.state === 'closed') onReopen(job)
                else onCloseJob(job)
              }}
            >
              {job.state === 'closed' ? 'Reopen' : 'Close'}
            </button>
          )}
          <button
            type="button"
            className="mi"
            role="menuitem"
            onClick={() => {
              close(false)
              onShare(job)
            }}
          >
            Share a read-only link
          </button>
          <a
            className="mi"
            role="menuitem"
            href={`/api/rooms/${encodeURIComponent(room.id)}/export.md`}
            download
            onClick={() => {
              // Let the browser start the download before the link unmounts, then return focus.
              window.setTimeout(() => close(), 0)
            }}
          >
            Export the whole room as Markdown
          </a>
          {!job.isDefault && (
            <button
              type="button"
              className="mi bad"
              role="menuitem"
              onClick={() => {
                close(false)
                onDelete(job)
              }}
            >
              <TrashIcon />
              Delete job
            </button>
          )}
        </div>
      )}
    </span>
  )
}
