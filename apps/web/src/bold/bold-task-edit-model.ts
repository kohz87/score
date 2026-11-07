import type { AgentSummary } from '@score/contract'
import { ApiError } from '../data/api.ts'
import { canTalkTo } from './bold-agents.ts'
import { pairingProblem } from './bold-errors.ts'

export function failureText(failure: unknown, verb: string): string {
  const pairing = pairingProblem(failure)
  if (pairing) return pairing
  if (failure instanceof ApiError && [400, 409].includes(failure.status)) return failure.message
  return `Couldn’t ${verb}. Try again.`
}

/** Who can take work: ready agents (not setting up, leaving or removed). */
export const workers = (agents: AgentSummary[]) => agents.filter(canTalkTo)
