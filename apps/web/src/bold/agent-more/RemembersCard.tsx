import { useRef, useState, type FormEvent } from 'react'
import type { AgentDetail } from '@score/contract'
import { newId } from '../../data/ids.ts'
import { useMemory, useMemoryActions } from '../../routes/team/agent-tab-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { CloseIcon } from '../BoldIcons.tsx'
import { Fail, Loading, MoreCard, useFoldedList } from './MoreCard.tsx'

export function RemembersCard({ agent }: { agent: AgentDetail }) {
  const memory = useMemory(agent.id, '')
  const { add, remove } = useMemoryActions(agent.id)
  const [text, setText] = useState('')
  // One key per distinct text, so a retry after a lost response cannot add a second entry.
  const attempt = useRef<{ text: string; key: string } | null>(null)
  const items = memory.data?.pages.flatMap((page) => page.items) ?? []
  const list = useFoldedList(`memory:${agent.id}`, items)
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
      {memory.isPending && <Loading what="memory" />}
      {memory.isError && (
        <Fail>
          Couldn’t load memory.{' '}
          <button type="button" className="link" onClick={() => void memory.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {memory.isSuccess && !items.length && <p className="small muted">Nothing remembered yet.</p>}
      {remove.isError && <Fail>{tabFailure(remove.error, 'forget that')}</Fail>}
      <div id={list.id} className="bold-fold-list">
        {list.shown.map((entry) => (
          <div className="listrow" key={entry.id}>
            <span className="grow small">{entry.text}</span>
            {writable && (
              <button
                type="button"
                className="act"
                aria-label={`Forget: ${entry.text.slice(0, 40)}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(entry.id)}
              >
                <CloseIcon />
              </button>
            )}
          </div>
        ))}
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
