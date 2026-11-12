import type { AgentSummary, CodingQuotaWindow, CodingRuntime } from '@score/contract'
import { Link } from 'react-router'
import { agentDisplayName } from '../bold-agents.ts'
import { InfoSection } from '../chats/InfoSection.tsx'
import {
  leftExact,
  leftPercent,
  loginLabel,
  planLabel,
  resetText,
  quotaReadSentence,
  quotaSummary,
  windowTitle,
  missingText,
} from '../../routes/team/quota-view.ts'
import { windowToneOf, type AgentQuotaView } from './quota-model.ts'
import { useAgentQuota } from './use-agent-quota.ts'
import './bold-quota.css'

const windowPhrase = (name: '5 hours' | 'week', group: string | null): string => {
  const base = name === 'week' ? 'week' : '5-hour window'
  return group ? `${group} ${base}` : base
}

function Row({ window, view }: { window: CodingQuotaWindow; view: AgentQuotaView }) {
  const left = leftPercent(window)
  const exact = leftExact(window)
  const resets = resetText(window.resetsAt, view.now)
  return (
    <div className="bold-quota-info-row">
      <div className="bold-quota-info-head">
        <b>{windowTitle(window)}</b>
        <span>{left === null ? missingText(window) : `${left}% left`}</span>
      </div>
      {/* A meter with an unknown share is not a meter: the words say it. */}
      {left !== null && exact !== null && (
        <span
          className="bold-quota-info-track"
          data-tone={windowToneOf(window, view.below)}
          role="meter"
          aria-label={`${windowTitle(window)} left`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={left}
          aria-valuetext={`${left}% left`}
        >
          <span className="bold-quota-fill" style={{ width: `${exact}%` }} />
        </span>
      )}
      {resets && <span className="bold-quota-reset">resets {resets}</span>}
    </div>
  )
}

function FloorLine({
  view,
  link,
  onNavigate,
}: {
  view: AgentQuotaView
  link: string
  onNavigate?: (() => void) | undefined
}) {
  const { floor } = view
  if (floor.kind === 'loading') return null
  return (
    <p className="bold-quota-floor-line">
      {floor.kind === 'unreadable'
        ? 'Its floor couldn’t be read.'
        : floor.percent > 0
          ? `Below ${floor.percent}% (its floor) Score starts no new work for it.`
          : 'Its floor is off (0%): Score starts new work until the limit is spent.'}{' '}
      <Link className="bold-quota-link" to={link} onClick={onNavigate}>
        Change the floor
      </Link>
    </p>
  )
}

/** Chat info's quota section for a coding agent (decision 186): every window, its floor and how the login is shared. */
export function DirectQuotaInfo({
  agent,
  runtime,
  onNavigate,
}: {
  agent: AgentSummary
  runtime: CodingRuntime
  onNavigate?: (() => void) | undefined
}) {
  const view = useAgentQuota(agent)
  const { below, quota } = view
  const name = agentDisplayName(agent)
  const changeFloor = `/b/agents/${encodeURIComponent(agent.id)}#agent-safety`
  let summary: string | undefined
  if (view.phase === 'error') summary = 'couldn’t be read'
  else if (quota) summary = quotaSummary(view.footer, view.group)

  return (
    <InfoSection
      kind="quota"
      className="bold-quota-section"
      headingId="dm-info-quota"
      title={`Quota · ${planLabel(runtime)}`}
      summary={summary}
      needsYou={below !== null}
    >
      {view.phase === 'loading' ? (
        <p className="bold-quota-note">Reading the quota…</p>
      ) : view.phase === 'error' ? (
        <p className="bold-quota-note">Quota couldn’t be read.</p>
      ) : view.phase === 'none' ? (
        <p className="bold-quota-note">
          {runtime === 'antigravity'
            ? 'Quota · not reported.'
            : 'Quota · shows after its first turn.'}
        </p>
      ) : quota === null ? (
        <p className="bold-quota-note">Quota · not reported.</p>
      ) : (
        <>
          <div className="bold-quota-info-list">
            {quota.windows.map((window) => (
              <Row key={`${window.group ?? ''}|${window.name}`} window={window} view={view} />
            ))}
          </div>
          <p className="bold-quota-read">{quotaReadSentence(quota, view.now)}</p>
          <FloorLine view={view} link={changeFloor} onNavigate={onNavigate} />
          {below && (
            <div className="bold-quota-floor-note" data-protected="block">
              <p>
                Score won’t start new work for {name} until the{' '}
                {windowPhrase(below.window.name, below.window.group)} resets at{' '}
                <b>{resetText(below.window.resetsAt, view.now)}</b>. What’s running finishes.
              </p>
              <div className="bold-quota-actions">
                <Link
                  className="btn sm primary bold-quota-link"
                  to={changeFloor}
                  onClick={onNavigate}
                >
                  Change the floor
                </Link>
                <Link className="btn sm ghost bold-quota-link" to="/b/agents" onClick={onNavigate}>
                  Use another agent
                </Link>
              </div>
            </div>
          )}
          <p className="bold-quota-shared">
            Shared with every agent on the same {loginLabel(runtime)} login.
          </p>
        </>
      )}
    </InfoSection>
  )
}
