// Webhook triggers (PLAN 11.1d, docs/briefs/11.0-bold.md §7). A trigger's signing secret is Score's own, sealed at
// rest and bound to the trigger's id. A verified call starts a job in the team room: the job's opening message is the
// trigger's template with the mapped values quoted, followed by the mapped fields as outside content under a "not
// instructions" label (F16). The lead gets the turn.

export {
  createTrigger,
  deleteTrigger,
  listTriggers,
  rotateTrigger,
  triggerSecret,
  updateTrigger,
} from './trigger-lifecycle.ts'
export { receiveCall, verifyCall, type CallResult } from './trigger-calls.ts'
