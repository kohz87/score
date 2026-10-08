import { useRef, useState, type FormEvent } from 'react'
import { useMemory, useMemoryActions } from './agent-tab-queries.ts'
import { tabFailure } from './tab-errors.ts'
import { newId } from '../../data/ids.ts'

export function MemoryTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const memory = useMemory(agentId, query)
  const { add, remove } = useMemoryActions(agentId)
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // One key per distinct text, so a retry after a lost response cannot add a second entry.
  const attempt = useRef<{ text: string; key: string } | null>(null)
  const items = memory.data?.pages.flatMap((page) => page.items) ?? []
  const writable = memory.data?.pages[0]?.writable !== false

  function search(event: FormEvent) {
    event.preventDefault()
    setQuery(draft.trim())
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const next = text.trim()
    if (attempt.current?.text !== next) attempt.current = { text: next, key: newId() }
    setNotice('')
    add.mutate(
      { text: next, key: attempt.current.key },
      {
        onSuccess: () => {
          attempt.current = null
          setText('')
          setNotice('Memory added.')
        },
      },
    )
  }
  return (
    <section className="team-card" aria-labelledby="team-memory-heading">
      <h2 id="team-memory-heading">Memory</h2>
      <form className="team-search" role="search" aria-label="Search memory" onSubmit={search}>
        <input
          type="search"
          aria-label="Search memory"
          placeholder={`Search ${agentName}'s memory`}
          maxLength={200}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (!event.target.value.trim()) setQuery('')
          }}
        />
        <button type="submit">Search</button>
      </form>
      {!writable && (
        <p className="team-muted" role="status">
          Memory is read-only here: Hermes has no way to add or remove a single entry from Score.
        </p>
      )}
      {writable && (
        <form className="team-routine-form" aria-label="Add memory" onSubmit={submit}>
          <label>
            New memory
            <textarea
              required
              rows={3}
              maxLength={2000}
              placeholder={`Something ${agentName} should remember`}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {add.isError && <p role="alert">{tabFailure(add.error, 'add the memory')}</p>}
          <div className="team-style-actions">
            <button type="submit" className="team-primary" disabled={add.isPending || !text.trim()}>
              {add.isPending ? 'Adding…' : 'Add memory'}
            </button>
          </div>
        </form>
      )}
      <p className="team-muted" role="status">
        {notice}
      </p>
      {memory.isPending && <p role="status">Loading memory…</p>}
      {memory.isError && (
        <p role="alert">
          Could not load memory. <button onClick={() => void memory.refetch()}>Try again</button>
        </p>
      )}
      {memory.isSuccess && !items.length && (
        <p className="team-muted-strong">{query ? 'No memories match.' : 'No memories yet.'}</p>
      )}
      {remove.isError && <p role="alert">{tabFailure(remove.error, 'delete the memory')}</p>}
      <ul className="team-routine-list">
        {items.map((entry) => (
          <li className="team-routine-row team-routine" key={entry.id}>
            <div className="team-routine-body">
              <p>{entry.text}</p>
              <p className="team-muted">
                {entry.source} · {new Date(entry.at).toLocaleDateString()}
              </p>
            </div>
            {writable && (
              <div className="team-routine-actions">
                {confirming === entry.id ? (
                  <button
                    type="button"
                    className="team-danger"
                    autoFocus
                    disabled={remove.isPending}
                    aria-label={`Confirm deleting memory: ${entry.text.slice(0, 40)}`}
                    onBlur={() => setConfirming(null)}
                    onClick={() =>
                      remove.mutate(entry.id, {
                        onSuccess: () => {
                          setConfirming(null)
                          setNotice('Memory deleted.')
                        },
                      })
                    }
                  >
                    Confirm delete
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Delete memory: ${entry.text.slice(0, 40)}`}
                    onClick={() => setConfirming(entry.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {memory.hasNextPage && (
        <button
          type="button"
          className="team-pill-button"
          disabled={memory.isFetchingNextPage}
          onClick={() => void memory.fetchNextPage()}
        >
          {memory.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  )
}
