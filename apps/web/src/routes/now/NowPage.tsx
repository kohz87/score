import type { ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import { useNow, useTeamPause } from './now-queries.ts'
import { AskingCard, MadeTodayCard, NowComposer, ThreadCard, TodoCard } from './NowCards.tsx'
import { FlowView } from './flow/FlowView.tsx'
import { RoutinesView } from './RoutinesView.tsx'
import { ScoreTimeline } from './ScoreTimeline.tsx'
import { useLayout, type NowArrangement as NowArrangementConfig } from '../../themes/layout.ts'
import type { NowSnapshot } from '@score/contract'
import { WatchPage } from '../watch/WatchPage.tsx'
import { OrchestrationNow } from '../orchestrations/OrchestrationNow.tsx'
import './now.css'

const views = [
  { to: '/now', label: 'Score', end: true },
  { to: '/now/flow', label: 'Flow', end: false },
  { to: '/now/routines', label: 'Routines', end: false },
] as const

/**
 * The Score view: Score's own arrangement, or the cards a theme arranged (PLAN 9.3): a grid with the theme's columns
 * and spans, the same card components. Needs-you is always among them (layout.ts adds it when a theme left it out); the
 * orchestration cards above stay full-width, as in the default.
 *
 * Both arrangements are one `div` at one tree position, and the composer is one keyed child of it, so a theme change
 * (another device's `look.changed`, a reset) moves the composer without remounting it: attachments, recipients and a
 * pending send survive. In the default the wrapper and the composer's slot are `display: contents`, so the page is
 * laid out exactly as before; a theme that leaves the composer out only hides it.
 */
function NowScore({
  snapshot,
  arrangement,
}: {
  snapshot: NowSnapshot
  arrangement: NowArrangementConfig | null
}) {
  const agents = snapshot.lanes.map((lane) => lane.agent)
  const working = snapshot.lanes.filter((lane) => lane.agent.status === 'working').slice(0, 2)
  const composer = (span: number | undefined, hidden: boolean) => (
    <div key="composer" className="now-slot" data-span={span} hidden={hidden}>
      <NowComposer roomId={snapshot.thread?.roomId ?? null} agents={agents} />
    </div>
  )
  if (!arrangement)
    return (
      <div className="now-body">
        {[
          <ScoreTimeline key="timeline" snapshot={snapshot} />,
          <div key="cards" className="now-cards">
            <ThreadCard thread={snapshot.thread} agents={agents} />
            {working.map((lane) => (
              <TodoCard key={lane.agent.id} agent={lane.agent} />
            ))}
            <AskingCard approval={snapshot.focusApproval} agents={agents} />
            <MadeTodayCard items={snapshot.madeToday} agents={agents} />
          </div>,
          composer(undefined, false),
        ]}
      </div>
    )
  const slot = (key: string, span: number, children: ReactNode) => (
    <div key={key} className="now-slot" data-span={span}>
      {children}
    </div>
  )
  return (
    <div className="now-body now-arrangement" data-columns={arrangement.columns}>
      {[
        ...arrangement.cards.flatMap(({ card, span }) => {
          switch (card) {
            case 'timeline':
              return [slot(card, span, <ScoreTimeline snapshot={snapshot} />)]
            case 'room':
              return [slot(card, span, <ThreadCard thread={snapshot.thread} agents={agents} />)]
            case 'needs-you':
              return [
                slot(card, span, <AskingCard approval={snapshot.focusApproval} agents={agents} />),
              ]
            case 'made-today':
              return [
                slot(card, span, <MadeTodayCard items={snapshot.madeToday} agents={agents} />),
              ]
            case 'todo':
              return working.map((lane) =>
                slot(`${card}-${lane.agent.id}`, span, <TodoCard agent={lane.agent} />),
              )
            case 'composer':
              return [composer(span, false)]
          }
        }),
        // A theme that leaves the composer out hides it; it stays mounted, so nothing typed or attached is lost.
        ...(arrangement.cards.some((entry) => entry.card === 'composer')
          ? []
          : [composer(undefined, true)]),
      ]}
    </div>
  )
}

export function NowPage() {
  const { pathname } = useLocation()
  const arrangement = useLayout().now
  const now = useNow()
  const pause = useTeamPause()
  const snapshot = now.data
  const paused = snapshot?.paused ?? false
  const view = pathname.startsWith('/now/flow')
    ? 'flow'
    : pathname.startsWith('/now/routines')
      ? 'routines'
      : pathname.startsWith('/now/watch/')
        ? 'watch'
        : 'score'
  // Watch has its own heading; it lives under Now but is not one of its three views.
  if (view === 'watch') return <WatchPage />
  return (
    <div className="now-page">
      <section className="now-title">
        <h1>{snapshot ? snapshot.headline.text : 'Now'}</h1>
        <div className="now-controls">
          <nav aria-label="Views" className="now-views">
            {views.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `now-view${isActive ? ' now-view--on' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            className="now-pause"
            // On phones the label is visually hidden (icon only); the tooltip says what it does.
            title={paused ? 'Resume everyone' : 'Pause everyone'}
            disabled={pause.isPending || !snapshot}
            onClick={() => pause.mutate({ paused: !paused })}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              {paused ? (
                <path d="M4.5 2.5 L13 8 L4.5 13.5 Z" fill="currentColor" />
              ) : (
                <path
                  d="M5.5 3 V13 M10.5 3 V13"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              )}
            </svg>
            {paused ? 'Resume everyone' : 'Pause everyone'}
          </button>
        </div>
      </section>
      {pause.isError && (
        <p className="now-error" role="alert">
          Couldn’t {paused ? 'resume' : 'pause'} the team. Try again.
        </p>
      )}
      {view === 'score' && <OrchestrationNow />}
      {view === 'flow' && <FlowView />}
      {view === 'routines' && <RoutinesView agents={snapshot?.lanes.map((lane) => lane.agent)} />}
      {view === 'score' &&
        (snapshot ? (
          <NowScore snapshot={snapshot} arrangement={arrangement} />
        ) : now.isError ? (
          <p className="now-error" role="alert">
            Couldn’t load the score.{' '}
            <button type="button" onClick={() => void now.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <p className="now-empty" role="status">
            Loading the score…
          </p>
        ))}
    </div>
  )
}
