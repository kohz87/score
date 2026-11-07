import { afterEach, beforeEach } from 'vitest'
import { exchangeHarness, type Harness } from './exchange-harness.ts'

export let h: Harness

export function installExchangeBudgetsHarness() {
  beforeEach(() => {
    h = exchangeHarness()
  })
  afterEach(() => h.close())
}

/** builder asks reviewer to review; reviewer sends back; repeat until the exchange can't go on. */
export function reviewUntilPaused() {
  h.ask('builder', 'Build the feed and get it reviewed.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  for (let i = 0; i < 20 && h.pending().length; i++) {
    const next = h.pending()[0]!.agent_id
    h.turn(
      next,
      next === 'reviewer'
        ? { action: 'send_back', note: 'Not yet.' }
        : { action: 'review', to: 'reviewer', note: 'Try again.' },
    )
  }
  return h.exchanges()[0]!
}
