import { useState, type FormEvent } from 'react'
import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { failure, TerminalCommand } from '../routes/settings/TerminalCommand.tsx'
import {
  useConnections,
  useRecheckSettings,
  useSettingsActions,
} from '../routes/settings/settings-queries.ts'

const statusLabel = {
  ok: 'Working',
  needs_signin: 'Sign in again',
  error: 'Not working',
} as const

/** PLAN 11.9a: Settings › Tools and triggers. Trigger UI waits on the 11.1d endpoints; tool servers use contract §10. */
export function BoldTools({ agents }: { agents: AgentSummary[] }) {
  const [command, setCommand] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', target: '' })
  const connections = useConnections(command !== null)
  const recheck = useRecheckSettings()
  const { addToolServer } = useSettingsActions()
  const names = new Map(agents.map((agent) => [agent.id, agent.name]))

  function add(event: FormEvent) {
    event.preventDefault()
    const target = draft.target.trim()
    const request = /^https?:\/\//i.test(target)
      ? { name: draft.name.trim(), url: target }
      : { name: draft.name.trim(), command: target.split(/\s+/) }
    addToolServer.mutate(request, {
      onSuccess: (result) => {
        if (result.command) setCommand(result.command)
        setDraft({ name: '', target: '' })
      },
    })
  }

  return (
    <div className="bold-tools">
      <h2 id="settings-tools">Tools and triggers</h2>

      <section className="card bold-tool-servers" aria-labelledby="bold-tool-servers-title">
        <div className="row wrap">
          <h3 id="bold-tool-servers-title">Tool servers</h3>
          <span className="small muted">Apps that expose actions to your agents (MCP)</span>
        </div>
        {connections.isPending && <p role="status">Loading tool servers…</p>}
        {connections.isError && (
          <p role="alert">Couldn’t load tool servers. Check that the Score server is running.</p>
        )}
        <div className="bold-tool-list">
          {connections.data?.toolServers.map((server) => (
            <div key={server.id} className="bold-tool-server" data-tool-server={server.id}>
              <span
                className="dot"
                data-status={
                  server.status === 'ok'
                    ? 'ok'
                    : server.status === 'needs_signin'
                      ? 'warn'
                      : 'error'
                }
                aria-hidden="true"
              />
              <span className="grow bold-tool-name">
                <b>{server.label}</b>
                <span className="small muted">
                  {server.usedBy === 'everyone'
                    ? 'Everyone'
                    : server.usedBy.map((id) => names.get(id) ?? id).join(', ')}
                </span>
              </span>
              <span className="bold-tool-agents" aria-label="Agents that can use it">
                {server.usedBy !== 'everyone' &&
                  server.usedBy.map((id) => {
                    const agent = agents.find((candidate) => candidate.id === id)
                    return agent ? (
                      <AgentGlyph key={id} agent={agent} size="xs" describeShape />
                    ) : null
                  })}
              </span>
              <span className="small muted" data-tool-status={server.status}>
                {statusLabel[server.status]}
              </span>
            </div>
          ))}
        </div>
        <form className="bold-tool-add" aria-label="Add a tool server" onSubmit={add}>
          <label>
            <span className="sr-only">Name</span>
            <input
              className="field"
              required
              aria-label="Name"
              pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,63}"
              placeholder="Name, e.g. Tickets app"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            <span className="sr-only">Address or command</span>
            <input
              className="field"
              required
              aria-label="Address or command"
              placeholder="https://… or a command"
              value={draft.target}
              onChange={(event) => setDraft({ ...draft, target: event.target.value })}
            />
          </label>
          <button type="submit" className="btn primary" disabled={addToolServer.isPending}>
            {addToolServer.isPending ? 'Working…' : 'Add tool server'}
          </button>
        </form>
        {addToolServer.isError && (
          <p role="alert">{failure(addToolServer.error, 'add this tool server')}</p>
        )}
        {command && (
          <TerminalCommand
            command={command}
            onClose={() => {
              setCommand(null)
              recheck()
            }}
          />
        )}
        <span className="small muted">
          Sign-in tokens are kept by Hermes in each agent’s own settings, never by Score.
        </span>
      </section>

      <section className="card bold-triggers" aria-labelledby="bold-triggers-title">
        <div className="row wrap">
          <h3 id="bold-triggers-title">Triggers</h3>
          <span className="small muted">Let another app start a job by calling an address</span>
        </div>
        <div className="bold-trigger-empty" role="status">
          <b>Triggers need the 11.1d API</b>
          <span className="small muted">
            Creating a trigger, showing its secret once and receiving a signed test call need the
            trigger endpoints and <code>/hooks</code> listener from 11.1d. Those endpoints are not
            in the API contract yet, so this page does not pretend to create one.
          </span>
        </div>
      </section>
    </div>
  )
}
