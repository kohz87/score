import type { ExchangeOption } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { pairingProblem } from '../bold-errors.ts'

export function decisionBody(
  option: ExchangeOption,
  form: { note: string; text: string; agent: string; usd: string; turns: string },
) {
  switch (option) {
    case 'more_turns':
      return { option, turns: Number(form.turns) }
    case 'more_spend':
      return { option, usd: Number(form.usd) }
    case 'step_in':
      return { option, text: form.text.trim() }
    case 'reassign':
      return { option, to: form.agent }
    case 'send_back':
      return { option, note: form.note.trim() }
    default:
      return { option }
  }
}

export function needsForm(option: ExchangeOption): boolean {
  return ['more_turns', 'more_spend', 'step_in', 'reassign', 'send_back'].includes(option)
}

export function decisionError(failure: unknown): string {
  const pairing = pairingProblem(failure)
  if (pairing) return pairing
  if (failure instanceof ApiError && failure.status === 409) return failure.message
  return 'Couldn’t send that decision. Try again.'
}
