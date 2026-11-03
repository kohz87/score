import type { Exchange } from '@score/contract'
import { needsYou } from './room-model.ts'

/**
 * The exchange the header, the decision card, step-in and the capsule all talk about: the one that needs the person
 * first, else the latest one still running, else the last one.
 */
export function currentExchange(exchanges: Exchange[]): Exchange | undefined {
  return (
    exchanges.find(needsYou) ??
    [...exchanges].reverse().find((item) => item.state !== 'done' && item.state !== 'stopped') ??
    exchanges.at(-1)
  )
}
