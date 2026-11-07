import { useRef, useState } from 'react'
import { ApiError } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { taskAction, useTaskRefresh, type TaskActionName } from './room/task-queries.ts'
import { failureText } from './bold-task-edit-model.ts'

type Move = { action: TaskActionName; label: string }
const MOVES: Record<string, Move[]> = {
  planned: [
    { action: 'start', label: 'Start' },
    { action: 'block', label: 'Block' },
  ],
  working: [
    { action: 'request_review', label: 'Ask for review' },
    { action: 'block', label: 'Block' },
    { action: 'complete', label: 'Mark done' },
  ],
  in_review: [
    { action: 'complete', label: 'Mark done' },
    { action: 'block', label: 'Block' },
  ],
}

/** The moves that make sense for the task's column. A blocked task has Unblock instead; a done one has none. */
export function TaskMoves({ taskId, column }: { taskId: string; column: string }) {
  const moves = MOVES[column] ?? []
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const keys = useRef<Record<string, string>>({})
  const refresh = useTaskRefresh()
  if (moves.length === 0) return null
  async function run(move: Move) {
    if (busy) return
    setBusy(move.action)
    setError(null)
    const key = (keys.current[move.action] ??= newId())
    try {
      await taskAction(taskId, move.action, undefined, key)
      delete keys.current[move.action]
      refresh()
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        delete keys.current[move.action]
      setError(failureText(failure, `${move.label.toLowerCase()} this task`))
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="bold-tb-section bold-tb-moves" aria-label="Move it">
      <h3>Move it</h3>
      <span className="bold-tb-actions">
        {moves.map((move) => (
          <button
            key={move.action}
            type="button"
            className="btn sm"
            disabled={busy !== null}
            onClick={() => void run(move)}
          >
            {busy === move.action ? 'Sending…' : move.label}
          </button>
        ))}
      </span>
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </section>
  )
}
