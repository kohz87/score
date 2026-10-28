import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { copyText } from '../../data/clipboard.ts'
import { useChangeMcpAccess, useMcpAccess } from '../../routes/team/mcp-access-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { Fail, MoreCard, problem } from './MoreCard.tsx'
import { ReloadMcp } from '../ReloadMcp.tsx'

/** Lets the agent use Score's rooms, tasks and notes as MCP tools. A consent, so the card is protected. */
export function ScoreAccessCard({ agent }: { agent: AgentDetail }) {
  const access = useMcpAccess(agent.id)
  const change = useChangeMcpAccess(agent.id)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // 3.13.2 (owner: two presses of Replace key cut the profile off): replacing asks first.
  const [confirmReplace, setConfirmReplace] = useState(false)
  if (access.isError || !access.data)
    return (
      <MoreCard id="agent-score-access" title="Score access" protectedKind="flex">
        {access.isError ? (
          <Fail>
            {problem(access.error, 'Couldn’t load Score access.')}{' '}
            <button type="button" className="link" onClick={() => void access.refetch()}>
              Try again
            </button>
          </Fail>
        ) : (
          <p role="status" className="small muted">
            Loading Score access…
          </p>
        )}
      </MoreCard>
    )
  const data = access.data
  const failed = change.patch.error ?? change.issue.error ?? change.revoke.error
  const busy = change.patch.isPending || change.issue.isPending || change.revoke.isPending
  const copy = (what: string, value: string) =>
    void copyText(value).then((ok) => setCopied(ok ? what : null))
  return (
    <MoreCard id="agent-score-access" title="Score access" protectedKind="flex">
      <span className="small muted">
        Lets {agent.name} use Score’s rooms, tasks and notes as tools. Off by default.
      </span>
      {failed && <Fail>{problem(failed, tabFailure(failed, 'change Score access'))}</Fail>}
      {!data.available && (
        <p className="small muted" role="status">
          Not available here: it is served on a separate local listener that only runs in remote
          mode.
        </p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={data.enabled}
          disabled={busy}
          onChange={() => change.patch.mutate({ enabled: !data.enabled })}
        />
        Read rooms, tasks and notes
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={data.writesEnabled}
          disabled={busy || !data.enabled}
          onChange={() => change.patch.mutate({ writesEnabled: !data.writesEnabled })}
        />
        <span>
          Write too <span className="small muted">posts are tagged “via MCP”</span>
        </span>
      </label>
      <span className="small muted">
        Posts in the last hour: {data.postsThisHour} (limit {data.postLimitPerHour}). Access key:{' '}
        {data.hasToken ? 'created, shown only once' : 'none yet'}.
      </span>
      <span className="row wrap">
        <button
          type="button"
          className="btn sm"
          disabled={busy || !data.available || confirmReplace}
          onClick={() =>
            data.hasToken
              ? setConfirmReplace(true)
              : change.issue.mutate(undefined, { onSuccess: (issued) => setToken(issued.token) })
          }
        >
          {data.hasToken ? 'Replace key' : 'Create key'}
        </button>
        {data.hasToken && (
          <button
            type="button"
            className="btn sm ghost"
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
      {confirmReplace && (
        <div role="alert" className="bold-mc-box">
          <span className="small">
            Replace the key? The current one stops working at once: {agent.name}’s Hermes can’t use
            Score’s tools until you put the new key in its profile (Setup in Hermes below).
          </span>
          <span className="row wrap">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                setConfirmReplace(false)
                change.issue.mutate(undefined, { onSuccess: (issued) => setToken(issued.token) })
              }}
            >
              Replace key
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirmReplace(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {token && (
        <div role="status" className="bold-mc-box">
          <span className="small">Copy this key now. Score can’t show it again.</span>
          <code>{token}</code>
          <button type="button" className="btn sm" onClick={() => copy('token', token)}>
            {copied === 'token' ? 'Copied' : 'Copy key'}
          </button>
        </div>
      )}
      {(data.command || data.hasToken) && (
        <details className="bold-mc-details">
          <summary className="link">Setup in Hermes</summary>
          {data.command && (
            <div className="bold-mc-box">
              <span className="small">
                Run this yourself in a terminal; Score doesn’t run it. It asks for the key.
              </span>
              <code>{data.command}</code>
              <button
                type="button"
                className="btn sm"
                onClick={() => copy('command', data.command ?? '')}
              >
                {copied === 'command' ? 'Copied' : 'Copy command'}
              </button>
            </div>
          )}
          {data.hasToken && data.command && (
            <span className="small muted" data-testid="mcp-rotate-note">
              After a new key, Hermes keeps the old one until you remove it: run{' '}
              <code>{data.command.replace(/ mcp add .*$/, '')} config unset MCP_SCORE_API_KEY</code>
              , then the command above, and paste the new key when it asks (Score never reads or
              writes the profile). Then Reload MCP below.
            </span>
          )}
        </details>
      )}
      {data.enabled && data.hasToken && (
        <div className="bold-mc-reload">
          <span className="small muted">
            After a new key or a Score update, {agent.name}’s Hermes needs to fetch Score’s tools
            again.
          </span>
          <ReloadMcp agentId={agent.id} agentName={agent.name} />
        </div>
      )}
    </MoreCard>
  )
}
