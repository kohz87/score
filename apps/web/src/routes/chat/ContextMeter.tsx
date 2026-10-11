import { useQuery } from '@tanstack/react-query'
import { useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError } from '../../data/api.ts'
import { MOTION, playMotion } from '../../motion/motion.ts'
import { useValueTween } from '../../motion/use-value-tween.ts'
import { StreamContext, useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { compact } from './context-meter.ts'
import {
  COMPACT_FAILURE_TEXT,
  fetchSessionContext,
  roomSessionId,
  sessionContextQuery,
  startCompaction,
  type SessionContextState,
} from './room-actions.ts'

const RADIUS = 11
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
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

/** Level of the ring: colour steps are redundant with the percentage in its name. */
export function ringLevel(fraction: number | null): 'normal' | 'warn' | 'high' {
  if (fraction === null) return 'normal'
  return fraction >= 0.9 ? 'high' : fraction >= 0.75 ? 'warn' : 'normal'
}

const percent = (fraction: number) => Math.min(100, Math.round(fraction * 100))

/** The ring and its figure. A new reading moves the stroke and counts the percentage to it (PLAN 5.37). */
function RingFace({ fraction, used }: { fraction: number | null; used: number | null }) {
  const fill = useRef<SVGCircleElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useValueTween(fraction, (value) => {
    fill.current?.setAttribute('stroke-dasharray', `${CIRCUMFERENCE * value} ${CIRCUMFERENCE}`)
    if (text.current) text.current.textContent = `${percent(value)}%`
  })
  return (
    <>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle className="chat-ctx-track" cx="14" cy="14" r={RADIUS} />
        {fraction !== null && (
          <circle
            ref={fill}
            className="chat-ctx-fill"
            cx="14"
            cy="14"
            r={RADIUS}
            strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
            transform="rotate(-90 14 14)"
          />
        )}
      </svg>
      <span ref={text} className="chat-ctx-text">
        {fraction !== null ? `${percent(fraction)}%` : compact(used ?? 0)}
      </span>
    </>
  )
}

/**
 * The token figure of a compaction result: counts down from the size before to the size after. Only a result that
 * arrives while the meter is already on screen (`seen`) counts; one that was there at the start just shows.
 */
function CountDown({
  from,
  to,
  seen,
}: {
  from: number
  to: number
  seen: React.RefObject<boolean>
}) {
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!seen.current) return
    const write = (value: number) => {
      if (text.current) text.current.textContent = compact(Math.round(value))
    }
    return playMotion(({ animate }) => {
      const state = { value: from }
      const animation = animate(state, {
        value: to,
        duration: MOTION.slow,
        ease: MOTION.ease,
        onUpdate: () => write(state.value),
        onComplete: () => write(to),
      })
      return () => {
        animation.cancel()
        write(to)
      }
    })
  }, [from, to, seen])
  return <span ref={text}>{compact(to)}</span>
}

interface MeterProps {
  roomId: string
  agentId: string
  name: string
  /** Changes after every finished reply: the reading is refreshed. */
  finishedReplies: number
  /** Opens the popover on the compact confirmation (the `/compress` command). */
  confirmSignal?: number | undefined
}

/**
 * A ring per agent in the composer footer (PLAN 5.36): how full the agent's context window is, with a popover that says
 * what uses it (Hermes's own accounting when the bridge can answer) and a Compact button. Inside the app the reading
 * follows the stream (`session.compacted`); without a stream connection (unit tests) it is a plain query.
 */
export function ContextMeter(props: MeterProps) {
  return useContext(StreamContext) ? <Streamed {...props} /> : <Polled {...props} />
}

function Streamed(props: MeterProps) {
  const sessionId = roomSessionId(props.roomId, props.agentId)
  const definition = useMemo(
    () => sessionContextQuery(props.agentId, sessionId),
    [props.agentId, sessionId],
  )
  const state = useStreamQuery(definition)
  const refetch = useStreamQueryRefetch(definition)
  return <MeterView {...props} data={state.data} refetch={() => void refetch()} />
}

function Polled(props: MeterProps) {
  const sessionId = roomSessionId(props.roomId, props.agentId)
  const query = useQuery({
    queryKey: ['chat', 'session-context', props.agentId, sessionId],
    queryFn: async (): Promise<SessionContextState> => ({
      context: await fetchSessionContext(props.agentId, sessionId),
      compaction: null,
    }),
    staleTime: 15_000,
    retry: false,
  })
  return <MeterView {...props} data={query.data} refetch={() => void query.refetch()} />
}

function MeterView({
  roomId,
  agentId,
  name,
  finishedReplies,
  confirmSignal,
  data,
  refetch,
}: MeterProps & { data: SessionContextState | undefined; refetch: () => void }) {
  const sessionId = roomSessionId(roomId, agentId)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [keepRecent, setKeepRecent] = useState(KEEP_RECENT)
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    refetch()
  }, [finishedReplies]) // eslint-disable-line react-hooks/exhaustive-deps -- only a finished reply refreshes it
  const compaction = data?.compaction ?? null
  const answeredId = compaction?.commandId
  useEffect(() => {
    if (!answeredId) return
    refetch()
  }, [answeredId]) // eslint-disable-line react-hooks/exhaustive-deps -- only a new answer refreshes it
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
      if (event.key === 'Escape') {
        setOpen(false)
        setConfirming(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
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
  // The answer to the command we started ends the wait.
  const busy = running !== null && running !== answeredId

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
        className={`chat-ctx-ring chat-ctx-ring--${level}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <RingFace fraction={fraction} used={used} />
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
