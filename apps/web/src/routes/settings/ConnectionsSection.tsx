import { useState, type FormEvent } from 'react'
import type { AgentSummary } from '@score/contract'
import { failure, TerminalCommand } from './TerminalCommand.tsx'
import { useConnections, useSettingsActions } from './settings-queries.ts'

export function ConnectionsSection({ agents }: { agents: AgentSummary[] }) {
  const connections = useConnections()
  const { addToolServer, connectMessaging } = useSettingsActions()
  const [command, setCommand] = useState<{ id: string; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', target: '' })
  const names = new Map(agents.map((agent) => [agent.id, agent.name]))

  function connect(platform: string) {
    connectMessaging.mutate(platform, {
      onSuccess: (result) => {
        if (result.command) setCommand({ id: `messaging:${platform}`, text: result.command })
      },
    })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const target = draft.target.trim()
    const request = /^https?:\/\//i.test(target)
      ? { name: draft.name.trim(), url: target }
      : { name: draft.name.trim(), command: target.split(/\s+/) }
    addToolServer.mutate(request, {
      onSuccess: (result) => {
        if (result.command) setCommand({ id: 'tool-server', text: result.command })
        setAdding(false)
        setDraft({ name: '', target: '' })
      },
    })
  }

  return (
    <section id="connections" className="settings-card" aria-labelledby="settings-connections">
      <div>
        <h2 id="settings-connections">Connections</h2>
        <p className="settings-muted-strong">
          Tools your agents can use, and places you can reach them.
        </p>
      </div>
      {connections.status === 'pending' && <p role="status">Loading connections…</p>}
      {connections.status === 'error' && (
        <p role="alert">Could not load connections. Check that the Score server is running.</p>
      )}
      {connections.data && (
        <div className="settings-columns">
          <div className="settings-column">
            <h3>Tool servers</h3>
            {connections.data.toolServers.length === 0 && (
              <p className="settings-muted">No tool servers yet.</p>
            )}
            <ul className="settings-chips">
              {connections.data.toolServers.map((server) => (
                <li key={server.id} className="settings-chip" data-status={server.status}>
                  <span className="settings-dot" data-status={server.status} aria-hidden="true" />
                  <span className="settings-chip-name">{server.label}</span>
                  <span className="settings-muted">
                    {server.status === 'needs_signin'
                      ? 'Sign in again'
                      : server.status === 'error'
                        ? 'Not working'
                        : 'Working'}
                    {' · '}
                    {server.usedBy === 'everyone'
                      ? 'Everyone'
                      : server.usedBy.map((id) => names.get(id) ?? id).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="settings-link settings-start"
              aria-expanded={adding}
              onClick={() => setAdding((open) => !open)}
            >
              Add a tool server
            </button>
            {adding && (
              <form className="settings-form" onSubmit={submit} aria-label="Add a tool server">
                <label>
                  Name
                  <input
                    required
                    pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,63}"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  Address or command
                  <input
                    required
                    placeholder="https://… or npx -y some-server"
                    value={draft.target}
                    onChange={(event) => setDraft({ ...draft, target: event.target.value })}
                  />
                </label>
                {addToolServer.isError && (
                  <p role="alert">{failure(addToolServer.error, 'add this tool server')}</p>
                )}
                <div className="settings-command-actions">
                  <button
                    type="submit"
                    className="settings-primary"
                    disabled={addToolServer.isPending}
                  >
                    Show the command
                  </button>
                  <button type="button" className="settings-link" onClick={() => setAdding(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {command?.id === 'tool-server' && (
              <TerminalCommand command={command.text} onClose={() => setCommand(null)} />
            )}
          </div>
          <div className="settings-column">
            <h3>Messaging</h3>
            <ul className="settings-chips">
              {connections.data.messaging.map((row) => (
                <li key={row.platform} className="settings-chip">
                  <span className="settings-dot" data-status={row.status} aria-hidden="true" />
                  <span className="settings-chip-name" data-missing={row.status !== 'connected'}>
                    {row.label}
                  </span>
                  <span className="settings-muted">
                    {row.status === 'connected' ? 'Connected' : (row.detail ?? 'Not connected')}
                  </span>
                  {row.status !== 'connected' && (
                    <button
                      type="button"
                      className="settings-link"
                      aria-label={`Connect ${row.label}`}
                      disabled={connectMessaging.isPending}
                      onClick={() => connect(row.platform)}
                    >
                      Connect
                    </button>
                  )}
                  {command?.id === `messaging:${row.platform}` && (
                    <TerminalCommand command={command.text} onClose={() => setCommand(null)} />
                  )}
                </li>
              ))}
            </ul>
            {connectMessaging.isError && (
              <p role="alert">{failure(connectMessaging.error, 'start the connection')}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
