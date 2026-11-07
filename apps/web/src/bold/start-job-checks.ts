import { ApiError } from '../data/api.ts'
import { describeCreateError } from '../routes/orchestrations/NewOrchestrationDialog.tsx'
import type { StartCheck } from './bold-start-job.ts'

export function checkOf(query: { isPending: boolean; isError: boolean }): StartCheck {
  if (query.isPending)
    return { key: 'team-room', status: 'pending', text: 'Checking the team room' }
  if (query.isError)
    return { key: 'team-room', status: 'fail', text: 'The team room could not be read' }
  return { key: 'team-room', status: 'ok', text: 'The team room is ready' }
}

export function checksFromPreflight(
  pending: boolean,
  failed: boolean,
  checks: { id: string; status: 'ok' | 'fail' | 'unknown'; message: string }[] | undefined,
  error?: unknown,
): StartCheck[] {
  if (pending)
    return [{ key: 'preflight', status: 'pending', text: 'Checking Hermes and the team' }]
  // The server's own reason in plain words, not "could not be read": a coding agent on a computer that can't run it as a
  // service, or one that can't take job steps (3.13.2, owner: full-access agents showed only "could not be read").
  if (
    failed &&
    error instanceof ApiError &&
    ['coding_workers_need_units', 'unsupported_agent'].includes(error.code)
  )
    return [{ key: 'preflight', status: 'fail', text: describeCreateError(error) }]
  if (failed || !checks)
    return [{ key: 'preflight', status: 'fail', text: 'The checks could not be read' }]
  return checks.map((check) => ({
    key: check.id,
    status: check.status === 'ok' ? 'ok' : 'fail',
    text: check.status === 'unknown' ? `${check.message} (could not be checked)` : check.message,
    ...(check.id === 'tool_readiness' && check.status !== 'ok' ? { reload: true } : {}),
  }))
}
