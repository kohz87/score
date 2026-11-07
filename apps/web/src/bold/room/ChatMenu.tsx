import { useId, useRef, useState } from 'react'
import { TrashIcon } from '../BoldIcons.tsx'
import { DotsIcon, moveInMenu, useMenu } from './menu-primitives.tsx'
import { useMenuPlacement } from './menu-placement.ts'

/** The one-to-one head's menu: deleted messages and delete this chat (a room's default thread can't be deleted). */
export function ChatMenu({
  showDeleted,
  onToggleDeleted,
  onDelete,
  onClear,
}: {
  showDeleted: boolean
  onToggleDeleted: () => void
  onDelete: (() => void) | undefined
  /** The main chat can't be deleted (it is the room's own thread), so it is cleared instead. */
  onClear?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useMenuPlacement(root, open)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = useMenu(open, setOpen, root, trigger)
  return (
    <span className="bold-job-menu-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        aria-label="Chat menu"
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
          aria-label="Chat actions"
          data-protected="flex"
          onKeyDown={moveInMenu}
        >
          <button
            type="button"
            className="mi"
            role="menuitemcheckbox"
            aria-checked={showDeleted}
            onClick={() => {
              close()
              onToggleDeleted()
            }}
          >
            {showDeleted ? 'Hide deleted messages' : 'Show deleted messages'}
          </button>
          {onClear && (
            <button
              type="button"
              className="mi bad"
              role="menuitem"
              onClick={() => {
                close(false)
                onClear()
              }}
            >
              <TrashIcon />
              Clear chat
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="mi bad"
              role="menuitem"
              onClick={() => {
                close(false)
                onDelete()
              }}
            >
              <TrashIcon />
              Delete chat
            </button>
          )}
        </div>
      )}
    </span>
  )
}
