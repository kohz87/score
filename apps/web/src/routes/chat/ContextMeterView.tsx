import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../../data/api.ts'
import { useCompactionMark } from '../../live/use-activity.ts'
import { compact } from './context-meter.ts'
import { CountDown } from './ContextMeterCountdown.tsx'
import { percent, RingFace, ringLevel } from './ContextMeterRing.tsx'
import {
  COMPACT_FAILURE_TEXT,
  roomSessionId,
  startCompaction,
  type SessionContextState,
} from './room-actions.ts'
import type { MeterProps } from './context-meter-types.ts'

const KEEP_RECENT = 2
// Segment fills for the "what uses it" bar; every segment is also a labelled row, so colour never carries it alone.
const SEGMENTS = [
  'var(--ink)',
  'var(--agent-violet)',
  'var(--agent-jade)',
  'var(--agent-saffron)',
  'var(--agent-coral)',
  'var(--agent-blue)',
  'var(--agent-unknown)',
  'var(--line-strong)',
]

export function MeterView({
  roomId,
  agentId,
  name,
  sessionId: suppliedSessionId,
  finishedReplies,
  confirmSignal,
  variant = 'ring',
  data,
  refetch,
}: MeterProps & { data: SessionContextState | undefined; refetch: () => void }) {
  const sessionId = suppliedSessionId ?? roomSessionId(roomId, agentId)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [keepRecent, setKeepRecent] = useState(KEEP_RECENT)
  const [running, setRunning] = useState<string | null>(null)
  // Commands whose result this view has seen. A result can arrive before the POST that started it resolves, and a
  // later compaction from another browser must not reopen a wait that already ended (S2-011).
  const [finished, setFinished] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    refetch()
  }, [finishedReplies]) // eslint-disable-line react-hooks/exhaustive-deps -- only a finished reply refreshes it
  const compaction = data?.compaction ?? null
  const answeredId = compaction?.commandId
  if (answeredId && !finished.has(answeredId)) setFinished(new Set(finished).add(answeredId))
  useEffect(() => {
    if (!answeredId) return
    refetch()
  }, [answeredId]) // eslint-disable-line react-hooks/exhaustive-deps -- only a new answer refreshes it
  // The status line says "Compacting context…" for as long as the wait lasts.
  const markCompacting = useCompactionMark()
  const waiting = running !== null && !finished.has(running)
  useEffect(() => {
    markCompacting(agentId, waiting)
    return () => markCompacting(agentId, false)
  }, [agentId, waiting, markCompacting])
  useEffect(() => {
    if (!open) return
    const outside = (event: globalThis.PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false)
        setConfirming(false)
      }
    }
    // Escape also works after the focused button went away (Compact now unmounts).
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // The meter's menu can sit inside the phone's side sheet: it is the top layer and owns the first Escape.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setConfirming(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  const lastSignal = useRef(confirmSignal)
  useEffect(() => {
    if (confirmSignal === undefined || confirmSignal === lastSignal.current) return
    lastSignal.current = confirmSignal
    setOpen(true)
    setConfirming(true)
    setError(null)
  }, [confirmSignal])

  const dataSeen = useRef(false)
  useEffect(() => {
    if (data) dataSeen.current = true
  }, [data])
  if (!data) return null
  const { context } = data
  const used = context.used
  const fraction = used !== null && context.window ? Math.min(1, used / context.window) : null
  const level = ringLevel(fraction)
  if (used === null && !context.parts) return null
  const label =
    fraction !== null
      ? `${name} context: ${percent(fraction)} % of ${compact(context.window!)}`
      : `${name} context: ${compact(used ?? 0)} tokens`
  // The answer to the command we started ends the wait, whenever it arrives.
  const busy = running !== null && !finished.has(running)

  function close(restore = true) {
    setOpen(false)
    setConfirming(false)
    if (restore) button.current?.focus()
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  async function run() {
    setError(null)
    setConfirming(false)
    try {
      setRunning(await startCompaction(agentId, sessionId, keepRecent))
    } catch (failure) {
      setRunning(null)
      setError(
        failure instanceof ApiError && failure.status === 409
          ? failure.message
          : 'Couldn’t start compacting. Try again.',
      )
    }
  }

  const parts = context.parts ?? []
  const total = Math.max(
    context.window ?? 0,
    parts.reduce((sum, part) => sum + part.tokens, 0),
    1,
  )
  const measured = context.measuredAt
    ? new Date(context.measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null
  return (
    <div
      className="chat-ctx"
      ref={root}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Focus moving to another control closes it; a focused button that unmounts (relatedTarget null) does not.
        if (
          open &&
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          close(false)
      }}
    >
      <button
        ref={button}
        type="button"
        className={
          variant === 'bar'
            ? `bold-context-meter chat-ctx-bar-trigger chat-ctx-ring--${level}`
            : `chat-ctx-ring chat-ctx-ring--${level}`
        }
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === 'bar' ? (
          <>
            Context{' '}
            <span className="bold-context-track" aria-hidden="true">
              <span style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} />
            </span>
            <span>{fraction !== null ? `${Math.round(fraction * 100)}%` : '–'}</span>
          </>
        ) : (
          <RingFace fraction={fraction} used={used} />
        )}
      </button>
      {busy && (
        <span className="chat-ctx-status" role="status">
          Compacting {name}…
        </span>
      )}
      {!busy && compaction && compaction.status === 'compacted' && compaction.before && (
        <span className="chat-ctx-status" role="status">
          {name} compacted: {compact(compaction.before.tokens)} →{' '}
          <CountDown
            key={answeredId}
            from={compaction.before.tokens}
            to={compaction.after!.tokens}
            seen={dataSeen}
          />{' '}
          tokens
        </span>
      )}
      {open && (
        <div
          className="chat-ctx-panel"
          id={panelId}
          role="dialog"
          aria-label={`${name} context details`}
        >
          <h3>{name}’s context</h3>
          <p className="chat-ctx-summary">
            {used !== null ? `${used.toLocaleString()} tokens used` : 'Usage unknown'}
            {context.window
              ? ` of ${context.window.toLocaleString()}${fraction !== null ? ` (${percent(fraction)} %)` : ''}`
              : ''}
            {context.source && context.source !== 'provider_usage' ? ' (estimate)' : ''}
          </p>
          <p className="chat-ctx-meta">
            {[
              context.model,
              measured ? `measured ${measured}` : null,
              context.autoCompactAt
                ? `Hermes compacts automatically at ${context.autoCompactAt.toLocaleString()} tokens${context.window ? ` (${percent(context.autoCompactAt / context.window)} %)` : ''}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {context.parts ? (
            <>
              <div className="chat-ctx-bar" aria-hidden="true">
                {parts.map((part, index) => (
                  <span
                    key={part.kind}
                    style={{
                      width: `${(part.tokens / total) * 100}%`,
                      background: SEGMENTS[index % SEGMENTS.length]!,
                    }}
                  />
                ))}
              </div>
              <h4>What is using it</h4>
              <ul className="chat-ctx-list">
                {parts.map((part, index) => (
                  <li key={part.kind}>
                    <span
                      className="chat-ctx-swatch"
                      aria-hidden="true"
                      style={{ background: SEGMENTS[index % SEGMENTS.length]! }}
                    />
                    <span className="chat-ctx-part">{part.label}</span>
                    <span className="chat-ctx-tokens">
                      {part.tokens.toLocaleString()} ·{' '}
                      {Math.round((part.tokens / total) * 1000) / 10} %
                    </span>
                  </li>
                ))}
              </ul>
              <p className="chat-ctx-note">
                Hermes’s own estimate. Older exchanges Hermes already summarised and files read into
                the conversation count under Messages.
              </p>
            </>
          ) : (
            <p className="chat-ctx-note">
              The breakdown of what uses the context isn’t available for this agent (Score’s plugin
              in Hermes can’t answer for it). The totals come from its latest reply.
            </p>
          )}
          {compaction && !busy && (
            <p className="chat-ctx-result" role="status">
              {compaction.status === 'compacted' && compaction.before && compaction.after
                ? `Compacted: ${compaction.before.messages} → ${compaction.after.messages} messages, ${compaction.before.tokens.toLocaleString()} → ${compaction.after.tokens.toLocaleString()} tokens.`
                : compaction.status === 'nothing'
                  ? 'Nothing to compact yet: the conversation is still short.'
                  : (COMPACT_FAILURE_TEXT[compaction.reason ?? 'compact_failed'] ??
                    COMPACT_FAILURE_TEXT.compact_failed)}
              {compaction.status === 'compacted' && compaction.memoryNote && (
                <>
                  {' '}
                  <Link
                    to={`/knowledge/${compaction.memoryNote.split('/').map(encodeURIComponent).join('/')}`}
                  >
                    Open the memory note
                  </Link>
                  .
                </>
              )}
            </p>
          )}
          {error && (
            <p className="chat-ctx-result" role="alert">
              {error}
            </p>
          )}
          {confirming ? (
            <div className="chat-ctx-confirm">
              <p>
                Hermes will summarise {name}’s older exchanges to free up context. The most recent{' '}
                <input
                  type="number"
                  aria-label="Exchanges kept word for word"
                  min={1}
                  max={20}
                  value={keepRecent}
                  onChange={(event) =>
                    setKeepRecent(
                      Math.max(1, Math.min(20, Math.round(Number(event.target.value)) || 1)),
                    )
                  }
                />{' '}
                exchanges stay word for word. This uses a model call.
              </p>
              <div className="chat-ctx-actions">
                <button type="button" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" className="chat-ctx-primary" onClick={() => void run()}>
                  Compact now
                </button>
              </div>
            </div>
          ) : (
            <div className="chat-ctx-actions">
              <button
                type="button"
                className="chat-ctx-primary"
                disabled={busy}
                onClick={() => {
                  setConfirming(true)
                  setError(null)
                }}
              >
                {busy ? 'Compacting…' : 'Compact'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
