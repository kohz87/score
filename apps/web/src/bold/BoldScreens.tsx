import type { AgentSummary, BotScreenStatus, WatchOverviewItem } from '@score/contract'
import { useQueries } from '@tanstack/react-query'
import { useMemo, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import {
  botScreenFrameUrl,
  botScreenQuery,
  useWatchOverview,
} from '../routes/watch/watch-queries.ts'
import { agentDisplayName, onTeam } from './bold-agents.ts'
import { boldAgentScreenLink } from './bold-links.ts'
import './bold-screens.css'

// 3.18.0: every agent's screen in one place, reached from the top bar. Mock-up:
// docs/design/bold/mockups/15-screens*.dc.html. Web only: it reads the watch overview and each agent's Bot Desktop status.

const PHONE = '(max-width: 600px)'
const POLL_MS = 5000

type Card = {
  agent: AgentSummary
  name: string
  doing: string
  bot: BotScreenStatus | undefined
  overview: WatchOverviewItem | undefined
}

type Badge = { text: string; tone: 'live' | 'control' | 'quiet'; dot: boolean }

function badgeOf(card: Card): Badge {
  if (card.bot?.state === 'running') return { text: 'Live desktop', tone: 'live', dot: true }
  if (card.bot?.state === 'human')
    return { text: 'Someone has control', tone: 'control', dot: false }
  if (card.overview?.live)
    return {
      text: card.overview.surface ? `Working · ${card.overview.surface}` : 'Working',
      tone: 'quiet',
      dot: false,
    }
  return { text: 'Idle', tone: 'quiet', dot: false }
}

const canTakeOver = (card: Card) => card.bot?.state === 'running' && !card.bot.control

function Surface({ surface }: { surface: 'terminal' | 'editor' | 'browser' }) {
  if (surface === 'terminal')
    return (
      <div className="bold-sc-code bold-sc-term" aria-hidden="true">
        <div>$ pnpm test</div>
        <div className="bold-sc-dim">ok tests pass</div>
      </div>
    )
  if (surface === 'editor')
    return (
      <div className="bold-sc-code" aria-hidden="true">
        <div className="bold-sc-dim">editing a file</div>
        <div className="bold-sc-del">- old line</div>
        <div className="bold-sc-add">+ new line</div>
      </div>
    )
  return (
    <div className="bold-sc-win" aria-hidden="true">
      <div className="bold-sc-bar" />
      <div className="bold-sc-page">
        <span />
        <span />
      </div>
    </div>
  )
}

/** The miniature's picture, in the brief's order: live frame, hidden while held, screenshot, drawing, nothing. */
function Picture({ card }: { card: Card }) {
  const { bot, overview } = card
  if (bot?.state === 'running')
    return (
      <img
        className="bold-sc-img"
        src={botScreenFrameUrl(card.agent.id, bot.frameSeq)}
        alt={`${card.name}’s desktop, live`}
        draggable={false}
      />
    )
  if (bot?.state === 'human')
    return (
      <div className="bold-sc-hidden">
        Someone has taken over this desktop. Score hides it while they work.
      </div>
    )
  // Until the desktop's state is known, a person may be using it: no picture of any kind yet.
  if (!bot) return <div className="bold-sc-none">Checking the screen…</div>
  if (overview?.thumbnail)
    return <img className="bold-sc-img" src={overview.thumbnail} alt="" draggable={false} />
  if (overview?.surface) return <Surface surface={overview.surface} />
  return <div className="bold-sc-none">Nothing on screen</div>
}

function DesktopCard({ card }: { card: Card }) {
  const badge = badgeOf(card)
  const to = boldAgentScreenLink(card.agent.id)
  return (
    <article className="bold-sc-card" aria-label={`${card.name}’s screen`}>
      <div className="bold-sc-mini" data-state={card.bot?.state ?? 'unknown'}>
        <Picture card={card} />
        <span
          className={`bold-sc-badge${badge.tone === 'control' ? ' bold-sc-control' : ''}`}
          data-tone={badge.tone}
          data-protected={badge.tone === 'control' ? 'inline-flex' : undefined}
        >
          {badge.dot && <span className="bold-sc-dot" aria-hidden="true" />}
          {badge.text}
        </span>
      </div>
      <div className="bold-sc-who">
        <AgentGlyph agent={card.agent} size="xs" bare decorative />
        <div className="bold-sc-text">
          <span className="bold-sc-name">{card.name}</span>
          <span className="bold-sc-doing">{card.doing}</span>
        </div>
      </div>
      <div className="bold-sc-actions">
        <Link className="bold-sc-open" to={to}>
          Open screen
        </Link>
        {canTakeOver(card) && (
          <Link className="bold-sc-take" to={`${to}?take=1`}>
            Take over…
          </Link>
        )}
      </div>
    </article>
  )
}

function PhoneRow({ card }: { card: Card }) {
  const badge = badgeOf(card)
  return (
    <Link
      className="bold-sc-row"
      to={boldAgentScreenLink(card.agent.id)}
      aria-label={`${card.name}, ${badge.text}. Open screen`}
    >
      <span className="bold-sc-mini" data-state={card.bot?.state ?? 'unknown'}>
        <Picture card={card} />
        {badge.dot && <span className="bold-sc-dot bold-sc-dot-red" aria-hidden="true" />}
      </span>
      <span className="bold-sc-text">
        <span className="bold-sc-name">{card.name}</span>
        <span
          className={`bold-sc-state${badge.tone === 'control' ? ' bold-sc-control' : ''}`}
          data-tone={badge.tone}
          data-protected={badge.tone === 'control' ? 'inline-flex' : undefined}
        >
          {badge.text}
        </span>
        {card.doing !== badge.text && <span className="bold-sc-doing">{card.doing}</span>}
      </span>
    </Link>
  )
}

export function BoldScreensPage() {
  const phone = useMediaQuery(PHONE)
  const agentsState = useStreamQuery(agentsQuery)
  const overview = useWatchOverview()
  const agents = useMemo(() => (agentsState.data ?? []).filter(onTeam), [agentsState.data])
  // One Bot Desktop status per agent, polled slowly (several agents) and only while the page is visible.
  const bots = useQueries({
    queries: agents.map((agent) => ({
      ...botScreenQuery(agent.id),
      refetchInterval: POLL_MS,
      refetchIntervalInBackground: false,
    })),
  })
  const cards: Card[] = agents.map((agent, index) => {
    const item = overview.items?.find((entry) => entry.agent.id === agent.id)
    return {
      agent,
      name: agentDisplayName(agent),
      doing: item?.status || 'Nothing going on',
      bot: bots[index]?.data,
      overview: item,
    }
  })
  const loading = agentsState.status === 'pending' && !agentsState.data
  const failed = agentsState.status === 'error' && !agentsState.data

  return (
    <div
      className="bold-page bold-sc"
      data-ui-page="screens"
      style={{ '--sc-min': '300px' } as CSSProperties}
    >
      <header className="bold-sc-head">
        <h1>Screens</h1>
        <p>
          What each agent is looking at right now. Open one to watch it, replay what it did, or take
          over its desktop.
        </p>
      </header>
      {overview.isError && (
        <p className="bold-sc-note" role="status">
          Score can’t read what the agents are doing right now.
        </p>
      )}
      {loading ? (
        <p className="bold-sc-note" role="status">
          Loading…
        </p>
      ) : failed ? (
        <p className="bold-sc-note" role="alert">
          Score can’t load the agents. Try again in a moment.
        </p>
      ) : cards.length === 0 ? (
        <p className="bold-sc-none-yet">No agents yet.</p>
      ) : phone ? (
        <div className="bold-sc-rows">
          {cards.map((card) => (
            <PhoneRow key={card.agent.id} card={card} />
          ))}
        </div>
      ) : (
        <div className="bold-sc-grid">
          {cards.map((card) => (
            <DesktopCard key={card.agent.id} card={card} />
          ))}
        </div>
      )}
    </div>
  )
}
