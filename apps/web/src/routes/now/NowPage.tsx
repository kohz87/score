import { NavLink, useLocation } from 'react-router'
import { useNow, useTeamPause } from './now-queries.ts'
import { AskingCard, MadeTodayCard, NowComposer, ThreadCard, TodoCard } from './NowCards.tsx'
import { FlowView } from './flow/FlowView.tsx'
import { RoutinesView } from './RoutinesView.tsx'
import { ScoreTimeline } from './ScoreTimeline.tsx'
import { WatchPage } from '../watch/WatchPage.tsx'
import { OrchestrationNow } from '../orchestrations/OrchestrationNow.tsx'
import './now.css'

const views = [
  { to: '/now', label: 'Score', end: true },
  { to: '/now/flow', label: 'Flow', end: false },
  { to: '/now/routines', label: 'Routines', end: false },
] as const

export function NowPage() {
  const { pathname } = useLocation()
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
          <>
            <ScoreTimeline snapshot={snapshot} />
            <div className="now-cards">
              <ThreadCard
                thread={snapshot.thread}
                agents={snapshot.lanes.map((lane) => lane.agent)}
              />
              {snapshot.lanes
                .filter((lane) => lane.agent.status === 'working')
                .slice(0, 2)
                .map((lane) => (
                  <TodoCard key={lane.agent.id} agent={lane.agent} />
                ))}
              <AskingCard
                approval={snapshot.focusApproval}
                agents={snapshot.lanes.map((lane) => lane.agent)}
              />
              <MadeTodayCard
                items={snapshot.madeToday}
                agents={snapshot.lanes.map((lane) => lane.agent)}
              />
            </div>
            <NowComposer
              roomId={snapshot.thread?.roomId ?? null}
              agents={snapshot.lanes.map((lane) => lane.agent)}
            />
          </>
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
