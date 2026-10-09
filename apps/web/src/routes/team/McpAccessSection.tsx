import type { AgentDetail } from '@score/contract'
import { useState } from 'react'
import { copyText } from '../../data/clipboard.ts'
import { useChangeMcpAccess, useMcpAccess } from './mcp-access-queries.ts'
import { tabFailure } from './tab-errors.ts'

// Team › agent › Tools › MCP access (contract §13, PLAN 7.4d). Score never runs the `hermes mcp add` command: it only
// shows it, because adding the entry writes the profile's Hermes configuration.
export function McpAccessSection({ agent }: { agent: AgentDetail }) {
  const access = useMcpAccess(agent.id)
  const change = useChangeMcpAccess(agent.id)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  if (access.isError || !access.data) return null
  const data = access.data
  const failed = change.patch.error ?? change.issue.error ?? change.revoke.error
  const busy = change.patch.isPending || change.issue.isPending || change.revoke.isPending
  const copy = (what: string, value: string) => {
    void copyText(value).then((ok) => setCopied(ok ? what : null))
  }
  return (
    <section className="team-card" aria-labelledby="team-mcp-heading">
      <h2 id="team-mcp-heading">MCP access</h2>
      <p className="team-muted-strong">
        Lets {agent.name} use Score&apos;s rooms, tasks and knowledge as MCP tools. Off by default.
      </p>
      {failed && <p role="alert">{tabFailure(failed, 'change MCP access')}</p>}
      {!data.available && (
        <p className="team-muted-strong" role="status">
          Not available here: MCP is served on Score&apos;s separate local listener, which only runs
          in remote mode.
        </p>
      )}
      <ul className="team-rows">
        <li>
          <span>
            MCP access<small> read rooms, tasks and notes</small>
          </span>
          <button
            type="button"
            role="switch"
            className="team-toggle"
            data-enabled={data.enabled}
            aria-checked={data.enabled}
            aria-label={`MCP access enabled for ${agent.name}`}
            disabled={busy}
            onClick={() => change.patch.mutate({ enabled: !data.enabled })}
          />
        </li>
        <li>
          <span>
            Writes
            <small> post to rooms, comment on tasks, write notes; posts are tagged “via MCP”</small>
          </span>
          <button
            type="button"
            role="switch"
            className="team-toggle"
            data-enabled={data.writesEnabled}
            aria-checked={data.writesEnabled}
            aria-label={`MCP writes enabled for ${agent.name}`}
            disabled={busy || !data.enabled}
            onClick={() => change.patch.mutate({ writesEnabled: !data.writesEnabled })}
          />
        </li>
        <li>
          <span>
            Posts in the last hour<small> limit {data.postLimitPerHour}</small>
          </span>
          <strong>{data.postsThisHour}</strong>
        </li>
        <li>
          <span>
            Token
            <small>
              {data.hasToken
                ? ` created ${new Date(data.tokenCreatedAt ?? 0).toLocaleString()}; shown only once`
                : ' none yet'}
            </small>
          </span>
          <span className="team-style-actions">
            <button
              type="button"
              disabled={busy || !data.available}
              onClick={() =>
                change.issue.mutate(undefined, { onSuccess: (issued) => setToken(issued.token) })
              }
            >
              {data.hasToken ? 'Rotate token' : 'Create token'}
            </button>
            {data.hasToken && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setToken(null)
                  change.revoke.mutate()
                }}
              >
                Revoke
              </button>
            )}
          </span>
        </li>
      </ul>
      {token && (
        <div role="status" className="team-mcp-box">
          <p>Copy this token now. Score keeps only a hash and cannot show it again.</p>
          <code>{token}</code>
          <button type="button" onClick={() => copy('token', token)}>
            {copied === 'token' ? 'Copied' : 'Copy token'}
          </button>
        </div>
      )}
      {data.command && (
        <div className="team-mcp-box">
          <p>
            To give this profile the entry, run this yourself in a terminal. Score does not run it,
            because it changes the profile&apos;s Hermes configuration. It asks for the token; paste
            it there.
          </p>
          <code>{data.command}</code>
          <button type="button" onClick={() => copy('command', data.command ?? '')}>
            {copied === 'command' ? 'Copied' : 'Copy command'}
          </button>
        </div>
      )}
    </section>
  )
}
