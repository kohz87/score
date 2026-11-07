import { ApiError } from '../../data/api.ts'

export function jobLifecycleError(
  error: unknown,
  action: 'close' | 'reopen' | 'delete' | 'rename',
) {
  if (error instanceof ApiError && error.status === 409)
    return error.message.includes('still working')
      ? {
          text: `This job is still working. Stop it first, then ${action} it.`,
          stillWorking: true,
        }
      : { text: error.message, stillWorking: false }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403))
    return { text: 'Pair this browser first.', stillWorking: false }
  return { text: `Couldn’t ${action} this job. Try again.`, stillWorking: false }
}
