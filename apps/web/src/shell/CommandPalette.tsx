import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { SearchSnippet } from '../components/SearchSnippet.tsx'
import { messageHref, useMessageSearch } from '../data/message-search.ts'
import { useMenu } from '../themes/layout.ts'
import { clearDeviceLook, lookStore } from '../themes/look-store.ts'

// Commands that run something instead of opening a page. "Reset look" is one of the ways back from a theme.
const commands = [
  {
    title: 'Reset look on this device',
    run: () => {
      clearDeviceLook()
      lookStore.setFailure(null)
    },
  },
]

/**
 * `userView` is the chat-first view's palette (re-gate #8): no admin destinations or message hits of its own, only the
 * way back, which goes through the view switch (the security password, when this browser asks for it).
 */
export function CommandPalette({
  onClose,
  userView,
}: {
  onClose: () => void
  userView?: { toAdmin: (path: string) => void }
}) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const navigate = useNavigate()
  const menu = useMenu()
  const destinations = userView
    ? [
        { path: '/now', title: 'Admin view' },
        { path: '/settings', title: 'Settings' },
      ]
    : menu
  const options = destinations.filter(({ title, name }) =>
    `${title} ${name ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const matchingCommands = commands.filter(({ title }) =>
    title.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const messages = useMessageSearch(userView ? '' : search, 8)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Tab') {
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>('input, a[href], button')
      const first = controls?.[0]
      const last = controls?.[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    } else if (event.key === 'Enter' && event.target === inputRef.current && options[0]) {
      event.preventDefault()
      if (userView) userView.toAdmin(options[0].path)
      else void navigate(options[0].path)
      onClose()
    } else if (
      event.key === 'Enter' &&
      event.target === inputRef.current &&
      matchingCommands[0] &&
      search.trim()
    ) {
      event.preventDefault()
      matchingCommands[0].run()
      onClose()
    }
  }
  return (
    <div
      className="command-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        data-protected="any"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="command-heading">
          <h2 id={titleId}>Search or run a command</h2>
          <button
            type="button"
            className="command-close"
            onClick={onClose}
            aria-label="Close command palette"
          >
            Esc
          </button>
        </div>
        <input
          ref={inputRef}
          className="command-input"
          type="search"
          aria-label="Search destinations"
          placeholder="Where would you like to go?"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ul className="command-options">
          {options.map(({ path, title, name }) => (
            <li key={path}>
              {userView ? (
                <button
                  type="button"
                  className="command-run"
                  data-protected="any"
                  onClick={() => {
                    userView.toAdmin(path)
                    onClose()
                  }}
                >
                  {title}
                </button>
              ) : (
                <Link
                  to={path}
                  onClick={onClose}
                  aria-label={name !== undefined && name !== title ? name : undefined}
                >
                  {title}
                </Link>
              )}
            </li>
          ))}
        </ul>
        {matchingCommands.length > 0 && search.trim() && (
          <section aria-label="Commands">
            <h3 className="command-section">Commands</h3>
            <ul className="command-options">
              {matchingCommands.map((command) => (
                <li key={command.title}>
                  <button
                    type="button"
                    className="command-run"
                    data-protected="any"
                    onClick={() => {
                      command.run()
                      onClose()
                    }}
                  >
                    {command.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {options.length === 0 && matchingCommands.length === 0 && !messages.data?.length && (
          <p>No destinations found.</p>
        )}
        {messages.data && messages.data.length > 0 && (
          <section aria-label="Messages">
            <h3 className="command-section">Messages</h3>
            <ul className="command-options">
              {messages.data.map((hit) => (
                <li key={hit.messageId}>
                  <Link
                    to={messageHref(hit.roomId, hit.messageId)}
                    className="command-hit"
                    onClick={onClose}
                  >
                    <span className="command-hit-where">{hit.roomName}</span>
                    <span>
                      <SearchSnippet text={hit.snippet} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
