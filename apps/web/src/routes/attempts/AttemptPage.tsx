import { type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { UnattributedGlyph } from '../../components/UnattributedGlyph.tsx'
import { ApiError } from '../../data/api.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../tasks/task-queries.ts'
import { attemptStatusLabel, evidenceLabel } from './attempt-format.ts'
import { useAttempt } from './attempt-queries.ts'
import './attempts.css'

const when = (iso: string) => new Date(iso).toLocaleString()

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="attempt-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function AgentsLookup({ agentId }: { agentId: string }) {
  const agents = useStreamQuery(taskAgentsQuery)
  const agent = agents.data?.find((item) => item.id === agentId)
  return (
    <span className="attempt-agent">
      {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
      {agent?.name ?? agentId}
    </span>
  )
}

/**
 * A read-only page for a Kanban attempt that has no task on the board Score follows now (or no task at all): the
 * task is shown as it was last observed. No actions, and no Watch link: nothing was observed to replay.
 */
export function AttemptPage() {
  const { attemptId = '' } = useParams()
  const attempt = useAttempt(attemptId)
  const detail = attempt.data
  return (
    <div className="attempt-page">
      <p className="attempt-back">
        <Link to="/tasks">Back to Tasks</Link>
      </p>
      {attempt.isPending && <p role="status">Loading attempt…</p>}
      {attempt.isError && (
        <div role="alert">
          <p>
            {attempt.error instanceof ApiError && attempt.error.status === 404
              ? 'This attempt is not available.'
              : 'The attempt could not load.'}
          </p>
          {!(attempt.error instanceof ApiError && attempt.error.status === 404) && (
            <button type="button" onClick={() => void attempt.refetch()}>
              Try again
            </button>
          )}
        </div>
      )}
      {detail && (
        <article className="attempt-card" aria-labelledby="attempt-heading">
          <header className="attempt-head">
            {detail.agentId === null ? <UnattributedGlyph /> : null}
            <div>
              <h1 id="attempt-heading">
                Attempt by{' '}
                {detail.agentId === null ? (
                  'an unattributed agent'
                ) : (
                  <AgentsLookup agentId={detail.agentId} />
                )}
              </h1>
              <p className="attempt-status">{attemptStatusLabel[detail.status]}</p>
            </div>
          </header>
          {!detail.task.current && (
            <p className="attempt-note">
              From an earlier copy of the board. This page is read-only: the task it belonged to is
              not on the board Score follows now.
            </p>
          )}
          {detail.task.current && (
            <p className="attempt-note">
              This attempt belongs to a task on the current board.{' '}
              <Link to={`/tasks/${encodeURIComponent(detail.task.taskId)}`}>Open the task</Link>
            </p>
          )}
          <section aria-labelledby="attempt-task-heading" className="attempt-section">
            <h2 id="attempt-task-heading">Task as last observed</h2>
            {detail.taskSnapshot ? (
              <dl className="attempt-rows">
                <Row label="Title">{detail.taskSnapshot.title}</Row>
                <Row label="Status">{detail.taskSnapshot.status}</Row>
                <Row label="Assignee">{detail.taskSnapshot.assignee ?? 'None'}</Row>
              </dl>
            ) : (
              <p className="attempt-muted">The task was not kept.</p>
            )}
          </section>
          <section aria-labelledby="attempt-facts-heading" className="attempt-section">
            <h2 id="attempt-facts-heading">What was observed</h2>
            <dl className="attempt-rows">
              <Row label="Agent">
                {detail.agentId === null ? (
                  'Unattributed'
                ) : (
                  <AgentsLookup agentId={detail.agentId} />
                )}
              </Row>
              <Row label="Role">{detail.role ?? 'Unknown'}</Row>
              <Row label="Started">{when(detail.startedAt)}</Row>
              <Row label="Ended">
                {detail.endedAt
                  ? when(detail.endedAt)
                  : detail.observationEndedAt
                    ? `No longer observed since ${when(detail.observationEndedAt)}`
                    : 'Still running'}
              </Row>
              {detail.closureReason && <Row label="Closed because">{detail.closureReason}</Row>}
              <Row label="Evidence">{evidenceLabel[detail.evidence]}</Row>
              {detail.refusedUpdates > 0 && (
                <Row label="Refused updates">{detail.refusedUpdates}</Row>
              )}
              <Row label="Tools, session and model">Not observed</Row>
              <Row label="Watch">Not observed</Row>
            </dl>
          </section>
        </article>
      )}
    </div>
  )
}
