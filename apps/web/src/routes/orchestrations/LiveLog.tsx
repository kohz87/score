import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LEAD_NODE } from './orch-model.ts'

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** What the log reads from an event: orchestration and workflow events both fit (7.1b). */
export type LogEvent = {
  id: string
  at: string
  kind: string
  tool?: string | null
  verdict: string | null
  summary: string
}

const kindLabel: Record<string, string> = {
  run_started: 'Run',
  lead_wake: 'Lead',
  lead_done: 'Lead',
  command: 'Call',
  step_admitted: 'Step',
  step_result: 'Result',
  step_state: 'Step',
  gate_opened: 'Gate',
  gate_decided: 'Gate',
  inquiry_opened: 'Question',
  inquiry_answered: 'Question',
  control: 'Run',
  node_state: 'Node',
  token: 'Token',
  planner: 'Planner',
  graph_end: 'Run',
}

const isBad = (event: LogEvent) =>
  (event.kind === 'command' && event.verdict !== 'accepted') ||
  event.verdict === 'failed' ||
  event.verdict === 'rejected' ||
  event.verdict === 'unknown' ||
  event.verdict === 'blocked' ||
  event.verdict === 'unresolved'

/**
 * The live log: one line per recorded event, including Score's verdict on every call the lead made. It is also the
 * accessible equivalent of the diagram. Follows the newest line until the person scrolls up.
 */
export function LiveLog({
  events,
  node,
  onClearNode,
  label,
}: {
  events: LogEvent[]
  node: string | null
  onClearNode: () => void
  label: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [behind, setBehind] = useState(0)
  const last = useRef(events.length)

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    if (stick.current) element.scrollTop = element.scrollHeight
  }, [events])
  useEffect(() => {
    const added = events.length - last.current
    last.current = events.length
    if (added > 0 && !stick.current) setBehind((n) => n + added)
  }, [events])

  return (
    <section className="orch-log" aria-label={label}>
      <header>
        <h3>Log</h3>
        {node !== null ? (
          <span className="orch-filter">
            Showing {node === LEAD_NODE ? 'the lead' : node}
            <button type="button" className="orch-link" onClick={onClearNode}>
              Show everything
            </button>
          </span>
        ) : (
          <span className="orch-muted">Everything. Click a node to filter.</span>
        )}
      </header>
      <div
        className="orch-log-scroll"
        ref={box}
        role="log"
        tabIndex={0}
        aria-label="Events"
        onScroll={() => {
          const element = box.current!
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
          if (stick.current) setBehind(0)
        }}
      >
        {events.length === 0 && <p className="orch-muted">Nothing here yet.</p>}
        <ol>
          {events.map((event) => (
            <li
              key={event.id}
              className={isBad(event) ? 'orch-log-bad' : undefined}
              data-kind={event.kind}
            >
              <time dateTime={event.at}>{clock(event.at)}</time>
              <span className="orch-log-kind">{kindLabel[event.kind] ?? 'Run'}</span>
              <span className="orch-log-text">{event.summary}</span>
            </li>
          ))}
        </ol>
      </div>
      {behind > 0 && (
        <button
          type="button"
          className="orch-jump"
          onClick={() => {
            const element = box.current!
            element.scrollTop = element.scrollHeight
            stick.current = true
            setBehind(0)
          }}
        >
          {behind} new, jump to latest
        </button>
      )}
    </section>
  )
}
