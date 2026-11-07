import { HttpError } from '../../errors.ts'
import { isTerminalStatus, type OrchRow } from './store.ts'

export function expectRevision(o: OrchRow, revision: number): void {
  if (o.revision !== revision)
    throw new HttpError(
      409,
      'conflict',
      'This run changed while you were looking. Reload and try again.',
      {
        currentRevision: o.revision,
      },
    )
}

export const mustBeLive = (o: OrchRow): void => {
  if (isTerminalStatus(o.status) || o.status === 'stopping' || o.status === 'finishing')
    throw new HttpError(409, 'conflict', `This run is ${o.status}.`)
}
