import { useState, type FormEvent } from 'react'
import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { failure, TerminalCommand } from '../routes/settings/TerminalCommand.tsx'
import {
  useConnections,
  useRecheckSettings,
  useRemoveConnection,
  useSettingsActions,
} from '../routes/settings/settings-queries.ts'
import { focusSoon, RemoveConfirm } from './RemoveConfirm.tsx'
import { BoldTriggers } from './BoldTriggers.tsx'
import { parseToolCommand } from './tool-command.ts'

// Score's own entry (the server's MCP_SERVER_NAME): agents reach Score through it, so it is never removed here (2.0.4).
const SCORE_TOOL_SERVER = 'score'

const statusLabel = {
  ok: 'Working',
  needs_signin: 'Sign in again',
  error: 'Not working',
} as const

/** PLAN 11.9a: Settings › Tools and triggers: tool servers use contract §10, triggers contract §17. */
export function BoldTools({ agents }: { agents: AgentSummary[] }) {
  const [command, setCommand] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', target: '' })
  const [formProblem, setFormProblem] = useState('')
  const connections = useConnections(command !== null)
  const recheck = useRecheckSettings()
  const { addToolServer } = useSettingsActions()
  const { removeToolServer } = useRemoveConnection()
  const [removing, setRemoving] = useState<string | null>(null)
  const names = new Map(agents.map((agent) => [agent.id, agent.name]))
  const appSuggestions = connections.data?.toolServers.map((server) => server.label) ?? []

  function add(event: FormEvent) {
    event.preventDefault()
    const target = draft.target.trim()
    const parsed = /^https?:\/\//i.test(target) ? null : parseToolCommand(target)
    if (parsed && !parsed.ok) {
      setFormProblem(parsed.error)
      return
    }
    const request = parsed
      ? { name: draft.name.trim(), command: parsed.argv }
      : { name: draft.name.trim(), url: target }
    setFormProblem('')
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
          <h3 id="bold-tool-servers-title" tabIndex={-1}>
            Tool servers
          </h3>
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
              {server.id !== SCORE_TOOL_SERVER && (
                <button
                  type="button"
                  className="btn sm ghost"
                  id={`remove-tool-${server.id}`}
                  aria-label={`Remove ${server.label}`}
                  aria-expanded={removing === server.id}
                  onClick={() => {
                    removeToolServer.reset()
                    setRemoving(removing === server.id ? null : server.id)
                  }}
                >
                  Remove
                </button>
              )}
              {removing === server.id && (
                <RemoveConfirm
                  what={server.label}
                  text={`Removes ${server.label} from Hermes. Agents drop it when the gateway restarts.`}
                  pending={removeToolServer.isPending}
                  error={removeToolServer.error}
                  onCancel={() => {
                    setRemoving(null)
                    focusSoon(`remove-tool-${server.id}`)
                  }}
                  onRemove={() =>
                    removeToolServer.mutate(server.id, {
                      onSuccess: () => {
                        setRemoving(null)
                        focusSoon('bold-tool-servers-title')
                      },
                    })
                  }
                />
              )}
            </div>
          ))}
        </div>
        <form
          className="bold-tool-add"
          data-protected="flex"
          aria-label="Add a tool server"
          noValidate
          onSubmit={add}
        >
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
              aria-describedby="bold-tool-command-hint"
              placeholder="https://… or a command"
              value={draft.target}
              onChange={(event) => {
                setDraft({ ...draft, target: event.target.value })
                setFormProblem('')
              }}
            />
          </label>
          <button type="submit" className="btn primary" disabled={addToolServer.isPending}>
            {addToolServer.isPending ? 'Working…' : 'Add tool server'}
          </button>
        </form>
        <span className="small muted" id="bold-tool-command-hint">
          Don’t paste tokens or passwords into the command. Keep credentials in Hermes; separate
          arguments with spaces and wrap an argument in quotes when it contains spaces.
        </span>
        {formProblem && <p role="alert">{formProblem}</p>}
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
          Adding gives you a command to run in Hermes. Testing a tool server is done in Hermes for
          now. Sign-in tokens are kept by Hermes in each agent’s own settings, never by Score.
        </span>
      </section>

      <BoldTriggers appSuggestions={appSuggestions} />
    </div>
  )
}
