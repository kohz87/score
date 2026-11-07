import type { AgentSummary, WatchFrame, WatchMarker } from '@score/contract'
import type { CSSProperties } from 'react'
import { BrowserPane, EditorPane, TerminalPane } from '../routes/watch/WatchStage.tsx'
import { clock, hostOf, surfaceLabels, type Surface } from '../routes/watch/watch-model.ts'
import { agentDisplayName } from './bold-agents.ts'

const surfaces: Surface[] = ['terminal', 'editor', 'browser']

const surfaceIcons: Record<Surface, string> = {
  terminal: 'M5 8l4 4-4 4M12 17h7',
  editor: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  browser:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
}

function SurfaceIcon({ surface }: { surface: Surface }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={surfaceIcons[surface]} />
    </svg>
  )
}

/** The other two screens, small beside the large one: a short look at what is on them, and a button that swaps it large. */
function SmallScreen({
  surface,
  frame,
  onShow,
}: {
  surface: Surface
  frame: WatchFrame | undefined
  onShow: () => void
}) {
  const label = surfaceLabels[surface]
  const where = frame?.terminal
    ? frame.terminal.cwd
    : frame?.editor
      ? frame.editor.path
      : frame?.browser
        ? frame.browser.url
          ? hostOf(frame.browser.url)
          : (frame.browser.title ?? '')
        : ''
  return (
    <button
      type="button"
      className={`bold-screen-small bold-screen-small--${surface}`}
      disabled={!frame}
      aria-label={frame ? `${label}, ${where}. Show large` : `${label}, nothing open`}
      onClick={onShow}
    >
      <span className="bold-screen-small-head">
        <SurfaceIcon surface={surface} />
        {label}
        {where && <span className="bold-screen-small-where"> · {where}</span>}
      </span>
      {!frame && <span className="bold-screen-small-empty">Nothing open</span>}
      {frame?.terminal && (
        <span className="bold-screen-small-body mono">
          <span className="bold-screen-small-cmd">$ {frame.terminal.command}</span>
          {frame.terminal.output.split('\n').slice(-4).join('\n')}
        </span>
      )}
      {frame?.editor && (
        <span className="bold-screen-small-body mono">
          {frame.editor.diff.split('\n').slice(0, 6).join('\n')}
        </span>
      )}
      {frame?.browser && (
        <span className="bold-screen-small-page">
          <b>{frame.browser.title || 'Untitled page'}</b>
          <span>{frame.browser.url}</span>
        </span>
      )}
    </button>
  )
}

export function BoldScreenStage({
  agent,
  live,
  marker,
  stage,
  frame,
  top,
  history,
  working,
  swapped,
  onShowSmall,
}: {
  agent: AgentSummary
  live: boolean
  marker: WatchMarker | null
  stage: {
    front: WatchFrame | null
    bySurface: Partial<Record<Surface, WatchFrame>>
  }
  frame: WatchFrame | null
  top: Surface | null
  history: NonNullable<WatchFrame['terminal']>[]
  working: boolean | undefined
  swapped: string
  onShowSmall: (surface: Surface) => void
}) {
  const small = surfaces.filter((name) => name !== top)
  return (
    <div
      className="bold-screen-stage"
      style={{ '--watch-agent': agent.style.color } as CSSProperties}
    >
      <span className="bold-screen-badge">{live ? 'Live' : `Replaying ${clock(marker!.at)}`}</span>
      {/* Announced when replay starts or ends, not on every scrub tick. */}
      <span className="sr-only" role="status">
        {live ? 'Live' : 'Replaying'}
      </span>
      <div className="bold-screen-stage-head">
        <span className="bold-screen-who">{agentDisplayName(agent)}’s screen</span>
        <span className="bold-screen-readonly">Read-only</span>
      </div>
      <div className="bold-screen-frames">
        <div className="bold-screen-window">
          {!frame && (
            <p className="bold-screen-empty">
              {live
                ? `${agentDisplayName(agent)} hasn’t opened anything yet.`
                : 'Nothing was on screen at that moment.'}
            </p>
          )}
          {frame?.terminal && (
            <TerminalPane
              terminal={frame.terminal}
              history={history}
              live={live && (working ?? true)}
            />
          )}
          {frame?.editor && <EditorPane editor={frame.editor} />}
          {frame?.browser && <BrowserPane browser={frame.browser} />}
        </div>
        <div role="group" aria-label="Other windows" className="bold-screen-smalls">
          {/* Keyed by place, not surface: the clicked button stays mounted (and focused) and now shows the screen that was large. */}
          {small.map((name, place) => (
            <SmallScreen
              key={place}
              surface={name}
              frame={stage.bySurface[name]}
              onShow={() => onShowSmall(name)}
            />
          ))}
          <span className="sr-only" role="status">
            {swapped}
          </span>
        </div>
      </div>
    </div>
  )
}
