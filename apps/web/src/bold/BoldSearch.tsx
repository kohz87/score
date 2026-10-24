import type { AgentSummary } from '@score/contract'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { apiFetch } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { clearDeviceLook, lookStore } from '../themes/look-store.ts'
import { SETTINGS_SECTIONS } from './BoldSettings.tsx'
import { BookIcon, SearchIcon } from './BoldIcons.tsx'
import {
  boldAddAgentLink,
  boldChatLink,
  boldCommandLink,
  boldFirstRunLink,
  boldJobLink,
  boldMessageLink,
  boldNoteLink,
  boldOneToOneLink,
  boldRecipesLink,
  boldSettingsSectionLink,
  boldStartJobLink,
} from './bold-links.ts'
import {
  buildBoldSearchGroups,
  flattenBoldSearch,
  nextBoldSearchIndex,
  type BoldSearchGroup,
  type BoldSearchResult,
} from './bold-search-model.ts'
import {
  useBoldCommands,
  useBoldDirectChats,
  useBoldMessageSearch,
  useBoldNotes,
  useBoldPaused,
  useBoldTeamRoom,
} from './bold-search-queries.ts'
import './bold-search.css'

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().replace(/^[/@]/, '').toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

/** Renders the FTS snippet's `[[matched]]` words without exposing the brackets. */
function MarkedSnippet({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const pattern = /\[\[(.*?)\]\]/gs
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    parts.push(<mark key={match.index}>{match[1]}</mark>)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.length ? <>{parts}</> : text.replaceAll('[[', '').replaceAll(']]', '')
}

/** The bold shell's ⌘K box (PLAN 11.10f): the prototype's grouped list, backed by the contract's searches. */
export function BoldSearch({
  agents,
  light,
  onClose,
  onToggleLook,
  onResetLook,
}: {
  agents: readonly AgentSummary[]
  light: boolean
  onClose: () => void
  onToggleLook: () => void
  onResetLook: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const pauseInFlight = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const listId = useId()
  const navigate = useNavigate()

  const team = useBoldTeamRoom({ fresh: true })
  const directs = useBoldDirectChats(agents)
  const notes = useBoldNotes(query)
  const messages = useBoldMessageSearch(query, 4)
  const commands = useBoldCommands()
  const pauseState = useBoldPaused()
  const paused = pausedOverride ?? (pauseState.isError ? null : (pauseState.data ?? false))
  const settings = useMemo(() => SETTINGS_SECTIONS.map(({ id, title }) => ({ id, title })), [])

  const groups = useMemo(
    () =>
      buildBoldSearchGroups({
        query,
        agents,
        teamJobs: team.data?.jobs ?? [],
        roomName: team.data?.room.name ?? 'Team room',
        directChats: directs.data ?? [],
        notes: notes.data ?? [],
        messages: messages.data ?? [],
        commands: commands.data ?? [],
        paused,
        light,
        settings,
      }),
    [
      query,
      agents,
      team.data,
      directs.data,
      notes.data,
      messages.data,
      commands.data,
      paused,
      light,
      settings,
    ],
  )
  const entries = useMemo(() => flattenBoldSearch(groups), [groups])
  const active =
    entries.length === 0 ? -1 : activeIndex >= 0 && activeIndex < entries.length ? activeIndex : 0
  const current = active >= 0 ? entries[active] : undefined

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (active < 0) return
    const option = document.getElementById(`${listId}-option-${active}`)
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [active, listId])

  const finish = (path?: string) => {
    if (path !== undefined) void navigate(path)
    onClose()
  }

  async function pauseTeam() {
    if (paused === null || pauseInFlight.current) return
    pauseInFlight.current = true
    setPending(true)
    setFailure(null)
    try {
      await apiFetch(paused ? 'team/resume' : 'team/pause', {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      })
      setPausedOverride(!paused)
      onClose()
    } catch {
      setFailure(paused ? 'Couldn’t resume everyone.' : 'Couldn’t pause everyone.')
    } finally {
      pauseInFlight.current = false
      setPending(false)
    }
  }

  async function select(result: BoldSearchResult) {
    switch (result.kind) {
      case 'job':
        finish(boldJobLink(result.jobId))
        break
      case 'chat':
        finish(boldChatLink(result.agentId, result.chatId))
        break
      case 'note':
        finish(boldNoteLink(result.path))
        break
      case 'message':
        finish(
          result.chatAgentId
            ? boldChatLink(result.chatAgentId, result.jobId)
            : boldMessageLink(result.jobId, result.messageId),
        )
        break
      case 'setting':
        finish(boldSettingsSectionLink(result.sectionId))
        break
      case 'command':
        finish(boldCommandLink(result.name))
        break
      case 'action': {
        const { action } = result
        if (action.type === 'pause') {
          await pauseTeam()
          return
        }
        if (action.type === 'toggle-look') {
          onToggleLook()
          onClose()
          return
        }
        if (action.type === 'reset-look') {
          clearDeviceLook()
          lookStore.setFailure(null)
          onResetLook()
          onClose()
          return
        }
        if (action.type === 'message-agent') {
          finish(boldOneToOneLink(action.agentId))
          return
        }
        if (action.type === 'start-job') finish(boldStartJobLink())
        else if (action.type === 'add-agent') finish(boldAddAgentLink())
        else if (action.type === 'recipes') finish(boldRecipesLink())
        else finish(boldFirstRunLink())
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      (event.nativeEvent.isComposing || event.keyCode === 229) &&
      (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp')
    )
      return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(nextBoldSearchIndex(active, direction, entries.length))
      return
    }
    if (event.key === 'Enter' && current !== undefined) {
      event.preventDefault()
      void select(current)
      return
    }
    if (event.key !== 'Tab') return
    const controls = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>('input, button, a[href]') ?? []),
    ].filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'))
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  const failed =
    team.isError || directs.isError || notes.isError || messages.isError || commands.isError
  const highlightQuery = query

  return (
    <div
      className="bold-search-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="bold-search-dialog"
        data-protected="any"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="bold-search-head">
          <SearchIcon />
          <h2 id={titleId} className="bold-search-sr">
            Search and commands
          </h2>
          <label htmlFor={`${listId}-input`} className="bold-search-sr">
            Search or run a command
          </label>
          <input
            ref={inputRef}
            id={`${listId}-input`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-option-${active}` : undefined}
            placeholder="Search jobs, chats, Library, or type a command"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
          />
          <button
            type="button"
            className="bold-search-esc kbd"
            onClick={onClose}
            aria-label="Close search"
          >
            esc
          </button>
        </div>

        <div id={listId} className="bold-search-list" role="listbox" aria-label="Results">
          {groups.length === 0 && <p className="bold-search-empty">Nothing matches.</p>}
          {groups.map((group) => (
            <ResultGroup
              key={group.key}
              group={group}
              active={active}
              entries={entries}
              listId={listId}
              query={highlightQuery}
              agents={agentById}
              onHover={setActiveIndex}
              onPick={(result) => void select(result)}
            />
          ))}
        </div>

        {failure && (
          <p className="bold-search-error" role="alert">
            {failure}
          </p>
        )}
        {failed && !failure && (
          <p className="bold-search-error" role="alert">
            Some results couldn’t be loaded.
          </p>
        )}

        <div className={`bold-search-foot${pending ? ' busy' : ''}`} aria-busy={pending}>
          <span>
            <b className="bold-search-key">↑↓</b> move
          </span>
          <span>
            <b className="bold-search-key">↵</b> open
          </span>
          <span>Type @ to talk to someone, / for a command</span>
        </div>
      </div>
    </div>
  )
}

function ResultGroup({
  group,
  active,
  entries,
  listId,
  query,
  agents,
  onHover,
  onPick,
}: {
  group: BoldSearchGroup
  active: number
  entries: readonly BoldSearchResult[]
  listId: string
  query: string
  agents: ReadonlyMap<string, AgentSummary>
  onHover: (index: number) => void
  onPick: (result: BoldSearchResult) => void
}) {
  const headingId = `${listId}-${group.key}`
  return (
    <div role="group" aria-labelledby={headingId}>
      <div className="bold-search-section" id={headingId}>
        {group.label}
      </div>
      {group.items.map((result) => {
        const index = entries.indexOf(result)
        const agentId =
          result.kind === 'chat'
            ? result.agentId
            : result.kind === 'message'
              ? result.agentId
              : null
        const agent = agentId ? agents.get(agentId) : undefined
        const icon =
          result.kind === 'job' ? (
            <span className="bold-search-job-tile" />
          ) : result.kind === 'note' ? (
            <BookIcon size={22} />
          ) : agent ? (
            <AgentGlyph agent={agent} size="sm" plain bare decorative />
          ) : null
        return (
          <button
            key={result.id}
            id={`${listId}-option-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            className={`bold-search-result${index === active ? ' active' : ''}`}
            data-protected="any"
            disabled={result.disabled}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(result)}
          >
            {icon && (
              <span className="bold-search-glyph" aria-hidden="true">
                {icon}
              </span>
            )}
            <span className="bold-search-copy">
              <span className="bold-search-title">
                {result.titleMarkup ? (
                  <MarkedSnippet text={result.titleMarkup} />
                ) : (
                  <Highlight text={result.title} query={query} />
                )}
              </span>
              {result.hint && (
                <span className="bold-search-hint">
                  {result.hintMarkup ? (
                    <MarkedSnippet text={result.hintMarkup} />
                  ) : (
                    <Highlight text={result.hint} query={query} />
                  )}
                </span>
              )}
            </span>
            {result.kind === 'job' && result.unread > 0 && (
              <span className="bold-search-unread" aria-label={`${result.unread} unread`}>
                {result.unread} unread
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
