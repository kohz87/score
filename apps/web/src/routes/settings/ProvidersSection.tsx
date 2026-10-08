import { useState, type FormEvent } from 'react'
import type { AgentSummary, ProviderItem } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { failure, TerminalCommand } from './TerminalCommand.tsx'
import { useProviders, useSettingsActions } from './settings-queries.ts'

const statusText = {
  connected: 'Connected',
  needs_signin: 'Sign in again',
  missing: 'Not connected',
} as const

function UsedBy({ ids, agents }: { ids: string[]; agents: AgentSummary[] }) {
  return (
    <span className="settings-glyphs">
      {ids.map((id) => {
        const agent = agents.find((candidate) => candidate.id === id)
        return agent ? (
          <AgentGlyph key={id} agent={agent} size="xs" describeShape />
        ) : (
          <span key={id} className="settings-muted">
            {id}
          </span>
        )
      })}
    </span>
  )
}

export function ProvidersSection({ agents }: { agents: AgentSummary[] }) {
  const providers = useProviders()
  const { connectProvider, addLocal } = useSettingsActions()
  const [command, setCommand] = useState<{ id: string; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ label: '', baseUrl: '', model: '' })
  const [notice, setNotice] = useState('')

  function connect(item: ProviderItem) {
    connectProvider.mutate(item.id, {
      onSuccess: (result) => {
        if (result.next === 'run_in_terminal' && result.command)
          setCommand({ id: item.id, text: result.command })
        else setNotice(`${item.label} is connected.`)
      },
    })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    addLocal.mutate(
      {
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
      },
      {
        onSuccess: (item) => {
          setDraft({ label: '', baseUrl: '', model: '' })
          setAdding(false)
          setNotice(`Added ${item.label}.`)
        },
      },
    )
  }

  return (
    <section id="models" className="settings-card" aria-labelledby="settings-models">
      <div>
        <h2 id="settings-models">Models and keys</h2>
        <p className="settings-muted-strong">
          Where your agents&apos; thinking comes from, and who uses what.
        </p>
      </div>
      {providers.status === 'pending' && <p role="status">Loading providers…</p>}
      {providers.status === 'error' && (
        <p role="alert">Could not load providers. Check that the Score server is running.</p>
      )}
      <ul className="settings-rows">
        {providers.data?.map((item) => (
          <li key={item.id} className="settings-row">
            <span className="settings-row-name" data-missing={item.status === 'missing'}>
              {item.label}
            </span>
            <UsedBy ids={item.usedBy} agents={agents} />
            {/* Don't repeat the status ("Not connected · Not connected"). */}
            {item.detail.toLowerCase() !== statusText[item.status].toLowerCase() && (
              <span className="settings-detail">{item.detail}</span>
            )}
            <span className="settings-status" data-status={item.status}>
              {statusText[item.status]}
            </span>
            <button
              type="button"
              className="settings-link"
              aria-label={`${item.status === 'connected' ? 'Edit' : 'Connect'} ${item.label}`}
              disabled={connectProvider.isPending}
              onClick={() => connect(item)}
            >
              {item.status === 'connected' ? 'Edit' : 'Connect'}
            </button>
            {command?.id === item.id && (
              <TerminalCommand command={command.text} onClose={() => setCommand(null)} />
            )}
          </li>
        ))}
        <li className="settings-row">
          <span className="settings-row-name" data-missing="true">
            Local model
          </span>
          <span className="settings-detail">Any OpenAI-compatible endpoint</span>
          <button
            type="button"
            className="settings-pill"
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
          >
            Add
          </button>
        </li>
      </ul>
      {adding && (
        <form className="settings-form" onSubmit={submit} aria-label="Add a local model">
          <label>
            Name
            <input
              required
              maxLength={80}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>
          <label>
            Address
            <input
              required
              type="url"
              placeholder="http://127.0.0.1:8080/v1"
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <label>
            Model
            <input
              required
              maxLength={200}
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
          </label>
          {addLocal.isError && <p role="alert">{failure(addLocal.error, 'add this model')}</p>}
          <div className="settings-command-actions">
            <button type="submit" className="settings-primary" disabled={addLocal.isPending}>
              Add model
            </button>
            <button type="button" className="settings-link" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {connectProvider.isError && (
        <p role="alert">{failure(connectProvider.error, 'start the sign-in')}</p>
      )}
      <p role="status" className="settings-muted-strong">
        {notice}
      </p>
    </section>
  )
}
