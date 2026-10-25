import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { AgentSummary, ConnectResult, MessagingPlatform, ProviderItem } from '@score/contract'
import { PairedBrowsersSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../data/api.ts'
import { ApiKeyPanel } from '../routes/settings/ApiKeyPanel.tsx'
import { MessagingSetup } from '../routes/settings/MessagingSetup.tsx'
import { isLocalProvider, providerAction } from '../routes/settings/ProvidersSection.tsx'
import { SignInPanel } from '../routes/settings/SignInPanel.tsx'
import { focusSoon, RemoveConfirm } from './RemoveConfirm.tsx'
import { failure, TerminalCommand } from '../routes/settings/TerminalCommand.tsx'
import {
  useConnections,
  useProviders,
  useMessagingFields,
  useRecheckSettings,
  useRemoveConnection,
  useSecurityStatus,
  useAddLocal,
  useSettingsActions,
  useSystemStatus,
} from '../routes/settings/settings-queries.ts'

const providerStatus = {
  connected: 'Connected',
  needs_signin: 'Sign in again',
  missing: 'Not connected',
} as const

function readable(detail: string | null): string {
  if (!detail) return ''
  if (!/^[a-z0-9_]+$/.test(detail)) return detail
  const words = detail.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function HermesCard({ agents }: { agents: AgentSummary[] }) {
  const system = useSystemStatus()
  const connected = system.data?.hermes.reachable === true
  const label = system.isPending
    ? 'Checking…'
    : system.isError
      ? 'Couldn’t check'
      : connected
        ? 'Connected'
        : 'Not reachable'
  return (
    <section className="card" aria-labelledby="bold-hermes-title">
      <div className="row wrap">
        <h3 id="bold-hermes-title">Hermes</h3>
        <span className="bold-connect-status" data-status={connected ? 'ok' : 'error'}>
          <span className="dot" data-status={connected ? 'ok' : 'error'} aria-hidden="true" />
          {label}
        </span>
      </div>
      <span className="bold-connect-detail">
        {system.data?.hermes.version ? `Version ${system.data.hermes.version}` : 'Version unknown'}
        {' · '}
        {system.data?.hermes.apiServer ? 'gateway running' : 'gateway not running'}
        {' · '}
        {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
      </span>
      <span className="small muted">
        Score reads Hermes and works through its gateway. It never opens your keys.
      </span>
      <button
        type="button"
        className="link"
        disabled={system.isFetching}
        onClick={() => void system.refetch()}
      >
        {system.isFetching ? 'Checking…' : 'Check again'}
      </button>
    </section>
  )
}

function ModelProvidersCard({ agents }: { agents: AgentSummary[] }) {
  const [showAll, setShowAll] = useState(false)
  const [panel, setPanel] = useState<
    { id: string; kind: 'key' } | { id: string; kind: 'device'; start: ConnectResult } | null
  >(null)
  const [command, setCommand] = useState<{ id: string; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ label: '', baseUrl: '', model: '', apiKey: '' })
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const { connectProvider } = useSettingsActions()
  const addLocal = useAddLocal()
  const { removeProvider } = useRemoveConnection()
  const providers = useProviders(command !== null)
  const recheck = useRecheckSettings()
  const names = new Map(agents.map((agent) => [agent.id, agent.name]))

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

  async function addLocalModel(event: FormEvent) {
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

  const all = [...(providers.data ?? [])].sort(
    (a, b) =>
      Number(a.status === 'missing') - Number(b.status === 'missing') ||
      a.label.localeCompare(b.label),
  )
  const inUse = all.filter((item) => item.status !== 'missing').length
  const visible = showAll ? all : all.slice(0, Math.max(inUse + 1, 4))

  return (
    <section className="card bold-conn-providers" aria-labelledby="bold-providers-title">
      <div className="row wrap">
        <h3 id="bold-providers-title">Model providers</h3>
        <span className="small muted">Where the team’s thinking comes from</span>
      </div>
      {providers.isPending && <p role="status">Loading providers…</p>}
      {providers.isError && (
        <p role="alert">Couldn’t load providers. Check that the Score server is running.</p>
      )}
      <div className="bold-connect-list">
        {visible.map((item) => (
          <div key={item.id} className="bold-connect-row" data-provider-id={item.id}>
            <span
              className="dot"
              data-status={
                item.status === 'connected' ? 'ok' : item.status === 'needs_signin' ? 'warn' : 'off'
              }
              aria-hidden="true"
            />
            <span className="grow bold-connect-name" data-missing={item.status === 'missing'}>
              {item.label}
              {item.usedBy.length > 0 && (
                <span className="small muted">
                  {' · '}
                  {item.usedBy.map((id) => names.get(id) ?? id).join(', ')}
                </span>
              )}
            </span>
            <span className="small muted" data-provider-status={item.status}>
              {item.status === 'connected'
                ? item.detail || providerStatus.connected
                : item.detail || providerStatus[item.status]}
            </span>
            {item.keySet && (
              <span className="small muted" data-key-set="true">
                Key set
              </span>
            )}
            {providerAction(item) && (
              <button
                type="button"
                className="btn sm"
                aria-label={`${providerAction(item)} ${item.label}`}
                disabled={connectProvider.isPending}
                onClick={() => connect(item)}
              >
                {providerAction(item)}
              </button>
            )}
            {item.status !== 'missing' && (
              <button
                type="button"
                className="btn sm ghost"
                id={`remove-provider-${item.id}`}
                aria-label={`Remove ${item.label}`}
                aria-expanded={removing === item.id}
                onClick={() => {
                  removeProvider.reset()
                  setRemoving(removing === item.id ? null : item.id)
                }}
              >
                Remove
              </button>
            )}
            {removing === item.id && (
              <RemoveConfirm
                what={item.label}
                text={
                  item.signIn === undefined
                    ? `Removes ${item.label} from every agent’s Hermes profile.`
                    : `Removes ${item.label} and its stored sign-in or key from Hermes. Agents can’t use it until you connect it again.`
                }
                pending={removeProvider.isPending}
                error={removeProvider.error}
                onCancel={() => {
                  setRemoving(null)
                  focusSoon(`remove-provider-${item.id}`)
                }}
                onRemove={() =>
                  removeProvider.mutate(item.id, {
                    onSuccess: () => {
                      setRemoving(null)
                      setNotice(`Removed ${item.label}.`)
                      focusSoon('bold-providers-notice')
                    },
                  })
                }
              />
            )}
            {panel?.id === item.id && panel.kind === 'key' && (
              <div className="bold-connect-panel" data-protected="block">
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
              </div>
            )}
            {panel?.id === item.id && panel.kind === 'device' && (
              <div className="bold-connect-panel" data-protected="block">
                <SignInPanel
                  label={item.label}
                  start={panel.start}
                  onConnected={recheck}
                  onClose={() => {
                    setPanel(null)
                    recheck()
                  }}
                  onRetry={() => connect(item)}
                  onTerminal={() => openTerminal(item, panel.start)}
                />
              </div>
            )}
            {command?.id === item.id && (
              <div className="bold-connect-panel" data-protected="block">
                <TerminalCommand
                  command={command.text}
                  onClose={() => {
                    setCommand(null)
                    recheck()
                  }}
                />
              </div>
            )}
          </div>
        ))}
        <div className="bold-connect-row" data-provider-id="local">
          <span className="dot" data-status="off" aria-hidden="true" />
          <span className="grow bold-connect-name" data-missing="true">
            Local model
          </span>
          <span className="small muted">Any OpenAI-compatible endpoint</span>
          <button
            type="button"
            className="btn sm"
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
          >
            Add
          </button>
          {adding && (
            <form
              className="settings-form bold-local-model"
              onSubmit={(event) => void addLocalModel(event)}
              aria-label="Add a local model"
            >
              <label>
                Name
                <input
                  className="field"
                  required
                  maxLength={80}
                  value={draft.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                />
              </label>
              <label>
                Address
                <input
                  className="field"
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
                  className="field"
                  required
                  maxLength={200}
                  value={draft.model}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
              </label>
              <label>
                API key (optional)
                <input
                  className="field"
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
              <span className="small muted">
                Only if the server asks for one (LM Studio with authentication on, a proxy, most
                hosted OpenAI-compatible servers). It goes to Hermes for every agent; Score
                doesn&rsquo;t keep it.
              </span>
              <span className="small muted">Every agent can use it.</span>
              {addLocal.error != null && (
                <p role="alert">{failure(addLocal.error, 'add this model')}</p>
              )}
              <div className="row wrap">
                <button type="submit" className="btn sm primary" disabled={addLocal.pending}>
                  Add model
                </button>
                <button type="button" className="link" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
      {all.length > visible.length && (
        <button type="button" className="link" onClick={() => setShowAll(true)}>
          Show all {all.length} providers
        </button>
      )}
      {connectProvider.isError && (
        <p role="alert">{failure(connectProvider.error, 'start the sign-in')}</p>
      )}
      {notice && (
        <p role="status" id="bold-providers-notice" tabIndex={-1}>
          {notice}
        </p>
      )}
    </section>
  )
}

/** Disconnect for a platform that is set up in the browser; others are cleared from the terminal. */
function ChannelRemove({ row }: { row: MessagingPlatform }) {
  const [open, setOpen] = useState(false)
  const fields = useMessagingFields(row.platform, row.status === 'connected' || Boolean(row.detail))
  const { removeMessaging } = useRemoveConnection()
  if (fields.data?.browserSetup !== true) return null
  return (
    <>
      <button
        type="button"
        className="btn sm ghost"
        id={`remove-channel-${row.platform}`}
        aria-label={`${row.status === 'connected' ? 'Disconnect' : 'Remove'} ${row.label}`}
        aria-expanded={open}
        onClick={() => {
          removeMessaging.reset()
          setOpen((now) => !now)
        }}
      >
        {row.status === 'connected' ? 'Disconnect' : 'Remove'}
      </button>
      {open && (
        <RemoveConfirm
          what={row.label}
          text={`Clears ${row.label}’s settings. It disconnects when the gateway restarts.`}
          pending={removeMessaging.isPending}
          error={removeMessaging.error}
          onCancel={() => {
            setOpen(false)
            focusSoon(`remove-channel-${row.platform}`)
          }}
          onRemove={() =>
            removeMessaging.mutate(row.platform, {
              onSuccess: () => {
                setOpen(false)
                focusSoon('bold-channels-title')
              },
            })
          }
        />
      )}
    </>
  )
}

function ChannelsCard() {
  const [setup, setSetup] = useState<string | null>(null)
  const connections = useConnections()
  const recheck = useRecheckSettings()
  return (
    <section className="card" aria-labelledby="bold-channels-title">
      <h3 id="bold-channels-title" tabIndex={-1}>
        Channels
      </h3>
      <span className="small muted">
        Talk to the team room from other apps; replies land in the room.
      </span>
      {connections.isPending && <p role="status">Loading channels…</p>}
      {connections.isError && <p role="alert">Couldn’t load channels. Try again later.</p>}
      <div className="bold-connect-list">
        {connections.data?.messaging.map((row) => (
          <div key={row.platform} className="bold-connect-row" data-channel={row.platform}>
            <span
              className="dot"
              data-status={row.status === 'connected' ? 'ok' : 'off'}
              aria-hidden="true"
            />
            <span className="grow bold-connect-name" data-missing={row.status !== 'connected'}>
              {row.label}
            </span>
            <span className="small muted">
              {row.status === 'connected' ? 'Connected' : readable(row.detail) || 'Not connected'}
            </span>
            {row.status !== 'connected' && (
              <button
                type="button"
                className="btn sm"
                aria-label={`Connect ${row.label}`}
                aria-expanded={setup === row.platform}
                onClick={() => setSetup(row.platform)}
              >
                Connect
              </button>
            )}
            <ChannelRemove row={row} />
            {setup === row.platform && (
              <div className="bold-connect-panel" data-protected="block">
                <MessagingSetup
                  platform={row.platform}
                  label={row.label}
                  terminalCommand="hermes gateway setup"
                  onSaved={recheck}
                  onClose={() => {
                    setSetup(null)
                    recheck()
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <span className="small muted">
        Sign-in tokens are kept by Hermes in its own settings, never by Score.
      </span>
    </section>
  )
}

function PhoneCard() {
  const browsers = useQuery({
    queryKey: ['session', 'browsers'],
    queryFn: async () => PairedBrowsersSchema.parse(await apiFetch('session/browsers')).items,
    retry: false,
  })
  const security = useSecurityStatus()
  const count = browsers.data?.length
  return (
    <section className="card bold-phone" aria-labelledby="bold-phone-title">
      <div className="grow">
        <h3 id="bold-phone-title">Your phone</h3>
        <span className="bold-connect-detail">
          Approvals reach you on any device paired with Score.
        </span>
        <span className="small muted">
          {count === undefined
            ? 'Reading paired devices…'
            : `${count} ${count === 1 ? 'device' : 'devices'} paired`}
          {security.data?.passwordSet ? ' · security password on' : ' · no security password'}
        </span>
        <Link className="link" to="/b/settings/security">
          Pair another device or manage devices
        </Link>
      </div>
      <span className="bold-phone-mark" aria-hidden="true">
        <svg
          width="46"
          height="46"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        >
          <rect x="6" y="2.5" width="12" height="19" rx="3" />
          <path d="M10 5.5h4M11 18.5h2" />
        </svg>
      </span>
    </section>
  )
}

function OtherAppsCard() {
  return (
    <section className="card" aria-labelledby="bold-other-apps-title">
      <h3 id="bold-other-apps-title">Other apps</h3>
      <span className="bold-connect-detail">
        Apps your agents use are <b>tool servers</b>. Apps that start jobs use{' '}
        <b>webhook triggers</b>.
      </span>
      <Link className="btn sm" to="/b/settings/tools">
        Open Tools and triggers
      </Link>
    </section>
  )
}

/** PLAN 11.9a: Settings › Connections, rebuilt from the prototype's sConn() and board 15. */
export function BoldConnections({ agents }: { agents: AgentSummary[] }) {
  return (
    <div className="bold-connections">
      <h2 id="settings-connections">Connections</h2>
      <div className="grid2">
        <HermesCard agents={agents} />
        <ModelProvidersCard agents={agents} />
        <ChannelsCard />
        <PhoneCard />
        <OtherAppsCard />
      </div>
    </div>
  )
}
