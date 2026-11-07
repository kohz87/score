// The graph editing model of the workflow editor (PLAN 7.1b): pure functions over the definition the contract
// describes. The editor keeps a draft of exactly that shape, so what is saved is what was edited. Nothing here
// validates the graph rules: the server does that (`POST /api/workflows/validate`), and the editor shows its answer.

export type { Draft } from './workflow-model-types.ts'
export { KIND_HELP, KIND_LABEL, describeCondition, portsOf } from './workflow-model-types.ts'
export { nextEdgeId, nextNodeId } from './workflow-model-ids.ts'
export {
  addNode,
  blankNode,
  removeNode,
  removeNodeJoining,
  renameNode,
  starterDraft,
  updateNode,
} from './workflow-nodes.ts'
export { ancestorsOf, connect, disconnect, edgesFrom, edgesTo } from './workflow-connections.ts'
export { addStepAfter, insertStepBefore, insertStepOnEdge } from './workflow-add-steps.ts'
export { addRule, removeRule, updateRule } from './workflow-branches.ts'
export { addInput, removeInput, renameInput } from './workflow-inputs.ts'
export { outlineOf } from './workflow-outline.ts'
export { ownText, sameDraft } from './workflow-model-helpers.ts'
