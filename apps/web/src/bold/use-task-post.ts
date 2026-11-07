import { useRef, useState } from 'react'
import { ApiError } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { pairingProblem } from './bold-errors.ts'
import { taskAction, useTaskRefresh } from './room/task-queries.ts'

function describeFailure(failure: unknown, verb: string): string {
  const pairing = pairingProblem(failure)
  if (pairing) return pairing
  if (failure instanceof ApiError && failure.status === 409) return failure.message
  return `Couldn’t ${verb} this task. Try again.`
}

/** One POST to the task's actions route; the key is kept across retries and renewed after a 4xx (as the room's form). */
export function useTaskPost(taskId: string, action: 'unblock' | 'comment') {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  const refresh = useTaskRefresh()
  async function run(text?: string) {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await taskAction(taskId, action, text, key.current)
      setSent(true)
      key.current = newId()
      refresh()
      return true
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        key.current = newId()
      setError(describeFailure(failure, action))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, sent, error, run }
}
