import { useCallback, useState, type FormEvent } from 'react'
import type { AgentSummary, ConnectResult, ProviderItem } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { ApiKeyPanel } from './ApiKeyPanel.tsx'
import { SignInPanel } from './SignInPanel.tsx'
import { failure, TerminalCommand } from './TerminalCommand.tsx'
import {
  useAddLocal,
  useProviders,
  useRecheckSettings,
  useSettingsActions,
} from './settings-queries.ts'

const statusText = {
  connected: 'Connected',
  needs_signin: 'Sign in again',
  missing: 'Not connected',
} as const

/** Local providers carry `keySet` and no `signIn` (contract §10, 2.0.10). */
export function isLocalProvider(item: ProviderItem): boolean {
  return item.keySet !== undefined && item.signIn === undefined
}

/**
 * What the button on a provider row does. A connected provider has a working edit flow only when it takes a
 * pasted key (adds another one). Browser sign-ins and terminal-only providers are connected already, and
 * "Edit" would restart the sign-in or show a `hermes auth add` command for a provider that works, so nothing
 * is offered; local endpoints live in the Hermes configuration (Advanced).
 */
export function providerAction(item: ProviderItem): string | null {
  if (isLocalProvider(item)) return item.keySet ? 'Change key' : 'Add key'
  if (item.status === 'missing') return 'Connect'
  if (item.status === 'needs_signin') return 'Reconnect'
  return item.signIn === 'api_key' ? 'Add key' : null
}

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
  const [showAll, setShowAll] = useState(false)
  const { connectProvider } = useSettingsActions()
  const addLocal = useAddLocal()
  const [command, setCommand] = useState<{ id: string; text: string } | null>(null)
  // Which provider shows a browser sign-in panel: a device-code sign-in or a key form (ARCHITECTURE D2.7).
  const [panel, setPanel] = useState<
    { id: string; kind: 'key' } | { id: string; kind: 'device'; start: ConnectResult } | null
  >(null)
  const providers = useProviders(command !== null)
  const recheck = useRecheckSettings()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ label: '', baseUrl: '', model: '', apiKey: '' })
  const [notice, setNotice] = useState('')

  function connect(item: ProviderItem) {
    setNotice('')
    setCommand(null)
    setPanel(null)
    if (item.signIn === 'api_key' || isLocalProvider(item)) {
      setPanel({ id: item.id, kind: 'key' })
      return
    }
    connectProvider.mutate(item.id, {
      onSuccess: (result) => {
        if (result.next === 'done') {
          setNotice(`${item.label} is connected.`)
          recheck()
        } else if (result.next === 'device_code' && result.signInId)
          setPanel({ id: item.id, kind: 'device', start: result })
        else if (result.command) setCommand({ id: item.id, text: result.command })
        else setNotice(`${item.label} is connected.`)
      },
    })
  }
  // The terminal command is the fallback for every panel; the server hands it back with the connect result.
  function openTerminal(item: ProviderItem, from?: ConnectResult) {
    setPanel(null)
    if (from?.command) {
      setCommand({ id: item.id, text: from.command })
      return
    }
    connectProvider.mutate(item.id, {
      onSuccess: (result) => {
        if (result.command) setCommand({ id: item.id, text: result.command })
      },
    })
  }
  const signedIn = useCallback(() => recheck(), [recheck])
  async function submit(event: FormEvent) {
    event.preventDefault()
    const apiKey = draft.apiKey.trim()
    const item = await addLocal.add({
      label: draft.label.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      ...(apiKey ? { apiKey } : {}),
    })
    // The key leaves state whether or not the server took it.
    setDraft((now) => ({
      ...now,
      apiKey: '',
      ...(item ? { label: '', baseUrl: '', model: '' } : {}),
    }))
    if (item) {
      setAdding(false)
      setNotice(`Added ${item.label}.`)
    }
  }

  // Hermes supports dozens of providers: the ones in use come first, the rest behind "Show all".
  const all = [...(providers.data ?? [])].sort(
    (a, b) =>
      Number(a.status === 'missing') - Number(b.status === 'missing') ||
      a.label.localeCompare(b.label),
  )
  const inUse = all.filter((item) => item.status !== 'missing').length
  const visible = showAll ? all : all.slice(0, Math.max(inUse + 4, 6))
  return (
    <section id="models" className="settings-card" aria-labelledby="settings-models">
      <div>
        <h2 id="settings-models">Models and keys</h2>
        <p className="settings-muted-strong">
          Where your agents’ thinking comes from, and who uses what.
        </p>
      </div>
      {providers.status === 'pending' && <p role="status">Loading providers…</p>}
      {providers.status === 'error' && (
        <p role="alert">Couldn’t load providers. Check that the Score server is running.</p>
      )}
      <ul className="settings-rows">
        {visible.map((item) => (
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
            {item.keySet && <span className="settings-detail">Key set</span>}
            {providerAction(item) && (
              <button
                type="button"
                className="settings-link"
                aria-label={`${providerAction(item)} ${item.label}`}
                disabled={connectProvider.isPending}
                onClick={() => connect(item)}
              >
                {providerAction(item)}
              </button>
            )}
            {panel?.id === item.id && panel.kind === 'key' && (
              <ApiKeyPanel
                providerId={item.id}
                label={item.label}
                local={isLocalProvider(item)}
                onSaved={() => {
                  setPanel(null)
                  setNotice(
                    isLocalProvider(item)
                      ? 'Key saved for every agent.'
                      : `${item.label} is connected.`,
                  )
                  recheck()
                }}
                onClose={() => setPanel(null)}
                onTerminal={() => openTerminal(item)}
              />
            )}
            {panel?.id === item.id && panel.kind === 'device' && (
              <SignInPanel
                label={item.label}
                start={panel.start}
                onConnected={signedIn}
                onClose={() => setPanel(null)}
                onRetry={() => connect(item)}
                onTerminal={() => openTerminal(item, panel.start)}
              />
            )}
            {command?.id === item.id && (
              <TerminalCommand
                command={command.text}
                onClose={() => {
                  setCommand(null)
                  recheck()
                }}
              />
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
      {all.length > visible.length && (
        <button type="button" className="settings-link" onClick={() => setShowAll(true)}>
          Show all {all.length} providers
        </button>
      )}
      {adding && (
        <form
          className="settings-form"
          onSubmit={(event) => void submit(event)}
          aria-label="Add a local model"
        >
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
          <label>
            API key (optional)
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              maxLength={512}
              pattern="[\x21-\x7e]{1,512}"
              title="Up to 512 characters, no spaces"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </label>
          <span className="settings-muted-strong">
            Only if the server asks for one (LM Studio with authentication on, a proxy, most hosted
            OpenAI-compatible servers). It goes to Hermes for every agent; Score doesn&rsquo;t keep
            it.
          </span>
          {addLocal.error != null && (
            <p role="alert">{failure(addLocal.error, 'add this model')}</p>
          )}
          <div className="settings-command-actions">
            <button type="submit" className="settings-primary" disabled={addLocal.pending}>
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
