// What happens when a turn in a room with `routing = exchanges` ends (docs/briefs/11.0-bold.md §4.3–§4.6,
// docs/briefs/11.1c-budgets.md): its staged actions are applied only if it completed, in the transaction that
// completes it; the answer to a question and the outcome of a review go back to whoever asked; a prose @mention hands
// nothing off. Every next turn of an exchange passes its budgets first, and every wait that has nobody to end it is
// handed to the person with options.

export { settleExchangeTurn } from './settle-turn.ts'
export { jobState } from './job-state.ts'
export { stopExchanges, stopTurns, TurnToStopSchema } from './exchange-stops.ts'
