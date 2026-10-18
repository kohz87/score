import type { AgentSummary, Approval, WatchFrame } from '@score/contract'
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useApprovalDecision } from '../chat/ApprovalCard.tsx'
import { clock, hostOf, parseDiff, surfaceLabels, type Surface } from './watch-model.ts'

const surfaces: Surface[] = ['terminal', 'editor', 'browser']

function Chrome({ title }: { title: string }) {
  return (
    <div className="watch-window__bar">
      <span className="watch-window__dot" />
      <span className="watch-window__dot" />
      <span className="watch-window__dot" />
      <span className="watch-window__title">{title}</span>
    </div>
  )
}

const statusText = {
  running: 'running',
  ok: 'finished',
  error: 'failed',
  paused: 'paused: waiting for approval',
} as const

export function TerminalPane({
  terminal,
  history = [],
  live,
}: {
  terminal: NonNullable<WatchFrame['terminal']>
  /** Earlier commands, oldest first. */
  history?: NonNullable<WatchFrame['terminal']>[]
  live: boolean
}) {
  const body = useRef<HTMLDivElement>(null)
  // The tail of a long output is what matters, so keep the newest lines in view.
  useLayoutEffect(() => {
    const element = body.current
    if (element) element.scrollTop = element.scrollHeight
  })
  const line = (entry: NonNullable<WatchFrame['terminal']>, key: string) => (
    <div key={key}>
      <div>
        <span className="watch-terminal__prompt">{entry.cwd}$</span> {entry.command}
      </div>
      {entry.output && <div className="watch-terminal__output">{entry.output}</div>}
    </div>
  )
  return (
    <>
      <Chrome title={`Terminal, ${terminal.cwd}`} />
      <div ref={body} className="watch-terminal" aria-live={live ? 'polite' : 'off'}>
        {history.map((entry, index) => line(entry, `h${index}`))}
        {line(terminal, 'now')}
        <div className={`watch-terminal__status watch-terminal__status--${terminal.status}`}>
          {terminal.status === 'running' ? (
            <>
              <span className="watch-terminal__cursor" aria-hidden="true" />
              <span>{statusText.running}</span>
            </>
          ) : (
            statusText[terminal.status]
          )}
        </div>
      </div>
    </>
  )
}

export function EditorPane({ editor }: { editor: NonNullable<WatchFrame['editor']> }) {
  const parts = editor.path.split('/').filter(Boolean)
  const lines = parseDiff(editor.diff)
  return (
    <>
      <Chrome title={editor.path} />
      <div className="watch-editor">
        <nav className="watch-editor__tree" aria-label="File path">
          {parts.map((part, index) => (
            <span
              key={`${index}-${part}`}
              className={index === parts.length - 1 ? 'watch-editor__file' : undefined}
              style={{ paddingLeft: index === 0 ? 0 : 10 }}
            >
              {part}
            </span>
          ))}
        </nav>
        <pre className="watch-editor__diff" aria-label={`Changes to ${editor.path}`}>
          {lines.map((line, index) =>
            line.kind === 'hunk' ? (
              index > 0 && (
                <span key={index} className="watch-diff watch-diff--hunk">
                  …
                </span>
              )
            ) : (
              <span key={index} className={`watch-diff watch-diff--${line.kind}`}>
                <span className="watch-diff__number">{line.number ?? ''}</span>
                <span className="watch-diff__text">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                  {line.text}
                </span>
              </span>
            ),
          )}
        </pre>
      </div>
    </>
  )
}

export function BrowserPane({ browser }: { browser: NonNullable<WatchFrame['browser']> }) {
  return (
    <>
      <Chrome title={`Browser, ${browser.url ? hostOf(browser.url) : (browser.title ?? '')}`} />
      <div className="watch-browser">
        <div className="watch-browser__address">
          <span>{browser.url || 'about:blank'}</span>
        </div>
        {browser.imageUrl ? (
          <img
            className="watch-browser__shot"
            src={browser.imageUrl}
            alt={`Screenshot of ${browser.title ?? browser.url}`}
          />
        ) : (
          <div className="watch-browser__placeholder">
            <span className="watch-browser__bar" />
            <span className="watch-browser__field" />
            <span className="watch-browser__field" />
            {browser.title && <span className="watch-browser__note">{browser.title}</span>}
          </div>
        )}
      </div>
    </>
  )
}

function ApprovalBar({ approval, agent }: { approval: Approval; agent: AgentSummary }) {
  const { busy, error, posted, decide } = useApprovalDecision(approval.id)
  const answered = posted !== null && posted.status !== 'pending'
  return (
    <div className="watch-approval" role="group" aria-label="Approval needed" data-protected="any">
      <span className="watch-approval__text">
        {agent.name} stopped
        {approval.command ? (
          <>
            {' '}
            before <code>{approval.command}</code>
          </>
        ) : (
          <>: {approval.title}</>
        )}{' '}
        and is waiting for you
        {error && (
          <span className="watch-approval__error" role="alert">
            {' '}
            {error}
          </span>
        )}
      </span>
      {approval.actionable && approval.choices.includes('once') && (
        <button
          type="button"
          className="watch-approval__go"
          disabled={busy || answered}
          onClick={() => void decide('once')}
        >
          Approve
        </button>
      )}
      {approval.actionable && approval.choices.includes('deny') && (
        <button
          type="button"
          className="watch-approval__no"
          disabled={busy || answered}
          onClick={() => void decide('deny')}
        >
          Deny
        </button>
      )}
      {!approval.actionable && (
        <a className="watch-approval__link" href="/chat">
          Answer in Chat
        </a>
      )}
    </div>
  )
}

export type WatchStageProps = {
  agent: AgentSummary
  bySurface: Partial<Record<Surface, WatchFrame>>
  front: WatchFrame | null
  /** null while live; the replayed moment while scrubbing. */
  replayAt: string | null
  /** The questions still waiting on the person; only shown while live. */
  approval: Approval | null
  /** Terminal frames before the current one, shown as scrollback. */
  history: WatchFrame[]
  /** Whether the agent has a live desktop. */
  live: boolean
}

export function WatchStage({
  agent,
  bySurface,
  front,
  replayAt,
  approval,
  history,
  live,
}: WatchStageProps) {
  const [pinned, setPinned] = useState<{ frame: number | null; surface: Surface } | null>(null)
  // A tab choice holds until another frame comes to the front.
  const pin = pinned && pinned.frame === (front?.seq ?? null) ? pinned.surface : null
  const top: Surface | null = pin ?? front?.surface ?? null
  const replaying = replayAt !== null
  const style = { '--watch-agent': agent.style.color } as CSSProperties
  const present = surfaces.filter((surface) => bySurface[surface])
  const shown = bySurface[top ?? 'terminal'] ?? null
  return (
    <section className="watch-stage" aria-label={`${agent.name}’s screen`} style={style}>
      <div className="watch-stage__bar">
        <span className="watch-stage__host">{agent.name}</span>
        <div role="group" aria-label="Screens" className="watch-stage__tabs">
          {surfaces.map((surface) => (
            <button
              key={surface}
              type="button"
              aria-pressed={top === surface}
              disabled={!bySurface[surface]}
              className={
                top === surface ? 'watch-stage__tab watch-stage__tab--on' : 'watch-stage__tab'
              }
              onClick={() => setPinned({ frame: front?.seq ?? null, surface })}
            >
              {surfaceLabels[surface]}
            </button>
          ))}
        </div>
        <span className="watch-stage__spacer" />
        {(shown ?? front) && (
          <time dateTime={(shown ?? front)!.at}>{clock((shown ?? front)!.at)}</time>
        )}
      </div>
      <div className="watch-banner">
        {replaying ? (
          <>
            <span className="watch-banner__pill watch-banner__pill--replay">Replay</span>
            <span className="watch-banner__text" role="status">
              Replaying {clock(replayAt)}
            </span>
          </>
        ) : (
          <>
            <span className="watch-banner__pill">
              <span aria-hidden="true" className="watch-banner__dot" />
              Live
            </span>
            <span className="watch-banner__text">You’re watching. {agent.name} is in control.</span>
          </>
        )}
      </div>
      {present.length === 0 && (
        <p className="watch-stage__empty" role="status">
          {live
            ? `${agent.name} hasn’t opened anything yet.`
            : `No desktop open. ${agent.name} has nothing to show here yet.`}
        </p>
      )}
      {present.map((surface) => {
        const frame = bySurface[surface]!
        const isTop = surface === top
        return (
          <div
            key={surface}
            className={`watch-window watch-window--${surface}${isTop ? ' watch-window--front' : ''}`}
            data-surface={surface}
            data-front={isTop ? 'true' : undefined}
            aria-label={surfaceLabels[surface]}
            role="group"
          >
            {frame.terminal && (
              <TerminalPane
                terminal={frame.terminal}
                history={history.flatMap((item) => (item.terminal ? [item.terminal] : []))}
                live={live && !replaying}
              />
            )}
            {frame.editor && <EditorPane editor={frame.editor} />}
            {frame.browser && <BrowserPane browser={frame.browser} />}
          </div>
        )
      })}
      {!replaying && present.length > 0 && (
        <div className="watch-cursor" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <path
              d="M3 2 L18 11 L11 12.5 L8 19.5 Z"
              fill="var(--watch-agent)"
              stroke="var(--watch-ink)"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          <span>{agent.name}</span>
        </div>
      )}
      {!replaying && approval && (
        <ApprovalBar key={approval.id} approval={approval} agent={agent} />
      )}
    </section>
  )
}
