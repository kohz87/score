import type { AgentSummary, Job, JobResults, ResultCard, WatchOverviewItem } from '@score/contract'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph, agentTint } from '../components/AgentGlyph.tsx'
import { ScreenMiniature } from '../routes/watch/SidePanels.tsx'
import '../routes/watch/watch.css'
import { agentDisplayName, agentNameColor } from './bold-agents.ts'
import { workbenchHref } from './bold-links.ts'
import { useBoldResults, type ResultsJob } from './bold-results-queries.ts'
import './bold-results.css'

type CardWithJob = { job: Job; card: ResultCard }
type ScreenWithJob = { job: Job; screen: JobResults['screens'][number] }

const STATE_LABEL: Record<Extract<ResultCard, { kind: 'change' }>['state'], string> = {
  working: 'Working',
  in_review: 'In review',
  sent_back: 'Sent back',
  approved: 'Approved',
  waiting_on_you: 'Needs you',
  done: 'Done',
}

type ChangeState = Extract<ResultCard, { kind: 'change' }>['state']

function AgentLine({ agent }: { agent: AgentSummary }) {
  return (
    <span className="bold-results-agent" style={{ color: agentNameColor(agent) }}>
      <AgentGlyph agent={agent} size="xs" bare decorative />
      {agentDisplayName(agent)}
    </span>
  )
}

function ChangeBadge({ state }: { state: Extract<ResultCard, { kind: 'change' }>['state'] }) {
  return (
    <span className="bold-results-badge" data-state={state}>
      {STATE_LABEL[state]}
    </span>
  )
}

function ChangeCard({
  job,
  card,
  agents,
}: {
  job: Job
  card: Extract<ResultCard, { kind: 'change' }>
  agents: Map<string, AgentSummary>
}) {
  return (
    <article className="bold-results-card bold-results-change" data-card="change">
      <header className="bold-results-card-head">
        <div>
          <h2>What changed</h2>
          <span className="bold-results-job">{job.title}</span>
        </div>
        <ChangeBadge state={card.state} />
      </header>
      <ul className="bold-results-changes">
        {card.whatChanged.map((line, index) => {
          const agent = line.by ? agents.get(line.by) : undefined
          return (
            <li key={`${line.text}-${index}`} className={line.caught ? 'caught' : undefined}>
              {agent ? (
                <AgentGlyph agent={agent} size="xs" bare decorative />
              ) : (
                <span className="bold-results-marker" aria-hidden="true" />
              )}
              <span>
                {line.text}
                {line.caught && (
                  <>
                    {' '}
                    <b>{agent ? agentDisplayName(agent) : (line.by ?? 'Someone')} caught this</b>.
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {card.files.length > 0 && (
        <Link className="bold-results-link" to={workbenchHref(job.id, 'code')}>
          See the code · {card.files.length} {card.files.length === 1 ? 'file' : 'files'}
        </Link>
      )}
    </article>
  )
}

function PreviewCard({
  job,
  card,
  states,
}: {
  job: Job
  card: Extract<ResultCard, { kind: 'preview' }>
  states: ChangeState[]
}) {
  const title = card.title ?? job.title
  const knownFinished = !card.live && (job.state === 'done' || job.state === 'closed')
  return (
    <article className="bold-results-card bold-results-preview" data-card="preview">
      <header className="bold-results-card-head">
        <div>
          <h2>{title}</h2>
          <span className="bold-results-job">{job.title}</span>
        </div>
        <span className="bold-results-preview-flags">
          {states.map((state, index) => (
            <ChangeBadge key={`${state}-${index}`} state={state} />
          ))}
          <span className={`bold-results-live${card.live ? ' is-live' : ''}`}>
            <span className={`bold-results-dot${card.live ? ' livedot' : ''}`} aria-hidden="true" />
            {card.live ? 'Live preview' : 'Saved preview'}
          </span>
        </span>
      </header>
      <Link
        className="bold-results-preview-stage"
        to={workbenchHref(job.id, 'screen')}
        aria-label={`Open ${title} in the Workbench`}
      >
        {card.imageUrl ? (
          <img src={card.imageUrl} alt={`Preview of ${title}`} />
        ) : (
          <span className="bold-results-preview-page" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}
      </Link>
      <p className="bold-results-note">
        Opened at <span className="bold-results-url">{card.url}</span>.{' '}
        {card.live
          ? 'Updates while the work is live.'
          : knownFinished
            ? 'The run has finished.'
            : null}
      </p>
    </article>
  )
}

function DraftCard({
  job,
  card,
  agent,
}: {
  job: Job
  card: Extract<ResultCard, { kind: 'draft' }>
  agent: AgentSummary | undefined
}) {
  const tint = agent ? agentTint(agent.style.color) : 'var(--field)'
  return (
    <article className="bold-results-card bold-results-draft" data-card="draft">
      <header className="bold-results-card-head">
        <div>
          <h2>{card.title}</h2>
          <span className="bold-results-job">{job.title}</span>
        </div>
        <span className="bold-results-draft-label">draft</span>
      </header>
      <span className="bold-results-draft-preview" style={{ background: tint }} aria-hidden="true">
        <span style={{ background: agent?.style.color ?? 'var(--faint)' }} />
        <span />
        <span />
      </span>
      <span className="bold-results-draft-by">
        {agent ? <AgentLine agent={agent} /> : card.agentId}
        <span className="bold-results-muted">
          {card.target.kind === 'document' ? 'Attached document' : 'In the workspace'}
        </span>
      </span>
      <Link className="bold-results-link" to={workbenchHref(job.id, 'draft')}>
        Open the draft
      </Link>
    </article>
  )
}

function ScreenCard({
  job,
  screen,
  agents,
  overview,
}: ScreenWithJob & {
  agents: Map<string, AgentSummary>
  overview: WatchOverviewItem[] | undefined
}) {
  const agent = agents.get(screen.agentId)
  if (!agent) return null
  const watched = overview?.find(
    (candidate) =>
      candidate.agent.id === agent.id &&
      candidate.surface === screen.surface &&
      candidate.live === screen.live,
  )
  // The overview is room-wide, not job-scoped: its thumbnail is safe only when it is the same agent's frame with
  // the same surface and live state as this job's screen. Everything else comes from `/results`.
  const item: WatchOverviewItem = {
    agent,
    thumbnail: watched?.thumbnail ?? null,
    status: '',
    live: screen.live,
    surface: screen.surface,
  }
  return (
    <Link
      className="bold-results-screen"
      to={workbenchHref(job.id, 'screen')}
      aria-label={`Watch ${agentDisplayName(agent)}’s screen`}
      data-card="screen"
    >
      <span className="watch-mini__screen bold-results-screen-thumb">
        <ScreenMiniature item={item} />
      </span>
      <span className="bold-results-screen-meta">
        <AgentGlyph agent={agent} size="xs" bare decorative />
        <b>{agentDisplayName(agent)}</b>
        {screen.live && <span className="bold-results-dot livedot" aria-label="Live" />}
      </span>
      <span className="bold-results-screen-caption" title={screen.caption}>
        {screen.caption}
      </span>
    </Link>
  )
}

export function BoldResultsEmpty() {
  return (
    <section className="bold-results-empty" aria-label="No results yet">
      <div className="bold-results-empty-tiles" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2>Nothing being made yet</h2>
      <p>
        Results land here as the team works: previews, drafts, what changed. Click any agent in the
        bar above to talk to it one to one.
      </p>
    </section>
  )
}

export function BoldResultsView({
  results,
  screens,
  agents,
  overview,
  pending = false,
  failed = false,
  onRetry,
  hidden = false,
}: {
  results: ResultsJob[]
  screens: ScreenWithJob[]
  agents: AgentSummary[]
  overview?: WatchOverviewItem[]
  pending?: boolean
  failed?: boolean
  onRetry?: () => void
  hidden?: boolean
}) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  const cards: CardWithJob[] = results
    .flatMap(({ job, result }) => result.items.map((card) => ({ job, card })))
    .sort((a, b) => b.card.at.localeCompare(a.card.at))
  const changes = cards.filter(
    (item): item is CardWithJob & { card: Extract<ResultCard, { kind: 'change' }> } =>
      item.card.kind === 'change',
  )
  const previews = cards.filter(
    (item): item is CardWithJob & { card: Extract<ResultCard, { kind: 'preview' }> } =>
      item.card.kind === 'preview',
  )
  const drafts = cards.filter(
    (item): item is CardWithJob & { card: Extract<ResultCard, { kind: 'draft' }> } =>
      item.card.kind === 'draft',
  )
  const changeStatesByJob = new Map<string, ChangeState[]>()
  for (const { job, card } of changes) {
    changeStatesByJob.set(job.id, [...(changeStatesByJob.get(job.id) ?? []), card.state])
  }
  const empty = cards.length === 0 && screens.length === 0

  if (pending && results.length === 0) {
    return (
      <div className="sidebody bold-results" hidden={hidden} data-testid="bold-results">
        <p className="bold-results-state" role="status">
          Looking at what changed…
        </p>
      </div>
    )
  }
  if (failed && results.length === 0) {
    return (
      <div className="sidebody bold-results" hidden={hidden} data-testid="bold-results">
        <div className="bold-results-error" role="alert">
          <p>Couldn’t load the Results. Try again.</p>
          {onRetry && (
            <button type="button" className="btn sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      </div>
    )
  }
  if (empty) {
    return (
      <div className="sidebody bold-results" hidden={hidden} data-testid="bold-results">
        <BoldResultsEmpty />
      </div>
    )
  }

  return (
    <div className="sidebody bold-results" hidden={hidden} data-testid="bold-results">
      {failed && (
        <div className="bold-results-inline-error" role="alert">
          <span>Some Results couldn’t be refreshed.</span>
          {onRetry && (
            <button type="button" className="btn sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      <div className="bold-results-grid">
        {previews.map(({ job, card }) => (
          <PreviewCard
            key={card.id}
            job={job}
            card={card}
            states={changeStatesByJob.get(job.id) ?? []}
          />
        ))}
        {changes.map(({ job, card }) => (
          <ChangeCard key={card.id} job={job} card={card} agents={agentById} />
        ))}
        {drafts.map(({ job, card }) => (
          <DraftCard key={card.id} job={job} card={card} agent={agentById.get(card.agentId)} />
        ))}
        {screens.length > 0 && (
          <section className="bold-results-screens" aria-label="Screens">
            <h2>Screens</h2>
            <div className="bold-results-screen-list">
              {screens.map(({ job, screen }) => (
                <ScreenCard
                  key={`${job.id}:${screen.agentId}:${screen.seq}`}
                  job={job}
                  screen={screen}
                  agents={agentById}
                  overview={overview}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export function BoldResults({ agents, hidden }: { agents: AgentSummary[]; hidden: boolean }) {
  const [search] = useSearchParams()
  const data = useBoldResults(!hidden, search.get('job'))
  return (
    <BoldResultsView
      results={data.results}
      screens={data.screens}
      agents={agents}
      overview={data.overview}
      pending={data.pending}
      failed={data.failed}
      onRetry={data.retry}
      hidden={hidden}
    />
  )
}
