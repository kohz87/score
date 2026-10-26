import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AgentDetail } from '@score/contract'
import { newId } from '../../data/ids.ts'
import { useMemory, useMemoryActions } from '../../routes/team/agent-tab-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { CloseIcon } from '../BoldIcons.tsx'
import { focusSoon, RemoveConfirm } from '../RemoveConfirm.tsx'
import { Fail, Loading, MoreCard, useFoldedList } from './MoreCard.tsx'

/** The note's text with every match of `query` wrapped in <mark> (case-insensitive, literal). */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: ReactNode[] = []
  let at = 0
  for (let hit = lower.indexOf(needle); hit >= 0; hit = lower.indexOf(needle, at)) {
    if (hit > at) parts.push(text.slice(at, hit))
    parts.push(<mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>)
    at = hit + needle.length
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

export function RemembersCard({ agent }: { agent: AgentDetail }) {
  const [find, setFind] = useState('')
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  // The list filters as you type from what is loaded; the server search follows once typing pauses.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(find.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [find])
  const needle = find.trim()
  const memory = useMemory(agent.id, query)
  const { add, remove } = useMemoryActions(agent.id)
  const [text, setText] = useState('')
  // One key per distinct text, so a retry after a lost response cannot add a second entry.
  const attempt = useRef<{ text: string; key: string } | null>(null)
  const items = (memory.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (entry) => !needle || entry.text.toLowerCase().includes(needle.toLowerCase()),
  )
  const list = useFoldedList(`memory:${agent.id}`, items)
  const searching = needle !== ''
  const writable = memory.data?.pages[0]?.writable !== false

  function submit(event: FormEvent) {
    event.preventDefault()
    const next = text.trim()
    if (!next) return
    if (attempt.current?.text !== next) attempt.current = { text: next, key: newId() }
    add.mutate(
      { text: next, key: attempt.current.key },
      {
        onSuccess: () => {
          attempt.current = null
          setText('')
        },
      },
    )
  }
  return (
    <MoreCard
      id="agent-memory"
      title="Remembers"
      count={memory.isSuccess ? `${items.length}${memory.hasNextPage ? '+' : ''}` : undefined}
    >
      <input
        type="search"
        className="field"
        id={`search-mem-${agent.id}`}
        aria-label="Search memory"
        placeholder={`Search ${agent.name}’s memory`}
        maxLength={200}
        value={find}
        onChange={(event) => setFind(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && find) {
            event.preventDefault()
            setFind('')
          }
        }}
      />
      {memory.isPending && !items.length && <Loading what="memory" />}
      {memory.isError && (
        <Fail>
          Couldn’t load memory.{' '}
          <button type="button" className="link" onClick={() => void memory.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {memory.isSuccess && !items.length && (
        <p className="small muted" role="status">
          {searching ? `No memories match “${needle}”.` : 'Nothing remembered yet.'}
        </p>
      )}
      <div id={list.id} className="bold-fold-list">
        {list.shown.map((entry) =>
          confirming === entry.id ? (
            <RemoveConfirm
              key={entry.id}
              what="memory"
              text={`Forget “${entry.text.length > 80 ? `${entry.text.slice(0, 80)}…` : entry.text}”? ${agent.name} will no longer remember it.`}
              pending={remove.isPending}
              error={remove.isError ? remove.error : null}
              onCancel={() => {
                remove.reset()
                setConfirming(null)
                focusSoon(`forget-${entry.id}`)
              }}
              onRemove={() =>
                remove.mutate(entry.id, {
                  onSuccess: () => {
                    setConfirming(null)
                    focusSoon(`search-mem-${agent.id}`)
                  },
                })
              }
            />
          ) : (
            <div className="listrow" key={entry.id}>
              <span className="grow small">
                <Highlighted text={entry.text} query={needle} />
              </span>
              {writable && (
                <button
                  type="button"
                  id={`forget-${entry.id}`}
                  className="act"
                  aria-label={`Forget: ${entry.text.slice(0, 40)}`}
                  onClick={() => {
                    remove.reset()
                    setConfirming(entry.id)
                  }}
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          ),
        )}
      </div>
      {list.toggle}
      {memory.hasNextPage && (
        <button
          type="button"
          className="link"
          disabled={memory.isFetchingNextPage}
          onClick={() => void memory.fetchNextPage()}
        >
          {memory.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
      {memory.isSuccess && !writable && (
        <p className="small muted" role="status">
          Hermes has no way to add or forget a single entry from Score.
        </p>
      )}
      {writable && (
        <form className="row" onSubmit={submit} aria-label="Add a memory">
          <label htmlFor={`newmem-${agent.id}`} className="sr">
            New memory
          </label>
          <input
            id={`newmem-${agent.id}`}
            className="field"
            maxLength={2000}
            placeholder="Something it should remember"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" className="btn sm" disabled={add.isPending || !text.trim()}>
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}
      {add.isError && <Fail>{tabFailure(add.error, 'add the memory')}</Fail>}
    </MoreCard>
  )
}
