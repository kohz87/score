import type { AgentSummary, ChatModel } from '@score/contract'

/** The model-per-chat words (decision 182; mock-ups docs/design/bold/mockups/27-model-*). */

/** Shown for the part of the tag that is the agent's own. */
export const OWN = 'its own'

/** The tag's amber style (the effort `max` one): a model set differently, or the costliest effort. */
export const isAmberChat = (model: ChatModel | null, effort: string | null) =>
  model !== null || effort === 'max'

/** The tag's text, "{model label} · {effort}"; the parts that are the agent's own read "its own". Null: nothing differs. */
export function chatTagParts(model: ChatModel | null, effort: string | null) {
  if (model === null && effort === null) return null
  return { model: model?.label ?? OWN, effort: effort ?? OWN }
}

/** The tag's accessible name: "reviewer in this chat: model deep, effort max. Change". */
export function chatTagLabel(name: string, model: ChatModel | null, effort: string | null) {
  const parts = chatTagParts(model, effort)
  return parts
    ? `${name} in this chat: model ${parts.model}, effort ${parts.effort}. Change`
    : `${name} in this chat: its own model and effort. Set for this chat`
}

/** A coding agent picks among its own program's models; a Hermes agent among its aliases and the models Hermes lists. */
export const isCodingAgent = (agent: Pick<AgentSummary, 'runtime'>) =>
  agent.runtime !== undefined && agent.runtime !== 'hermes'

const PROGRAMS: Record<string, { name: string; plan: string }> = {
  'claude-code': { name: 'Claude Code', plan: 'your Claude plan' },
  codex: { name: 'Codex', plan: 'your ChatGPT plan' },
  antigravity: { name: 'Antigravity', plan: 'your Google plan' },
}
export const programName = (runtime: string | undefined) =>
  PROGRAMS[runtime ?? '']?.name ?? runtime ?? 'its program'
export const programGroup = (runtime: string | undefined) => {
  const program = PROGRAMS[runtime ?? '']
  return program ? `${program.name.toUpperCase()} · ${program.plan}` : 'ITS PROGRAM'
}

/** The label a chat's model shows: the alias or name the person chose, with the model it resolves to when they differ. */
export const chosenLabel = (model: ChatModel) =>
  model.label === model.model ? model.label : `${model.label} (${model.model})`

/** At most this many models are listed in the palette; the rest are counted ("+ 14 more: keep typing to narrow"). */
export const PALETTE_MODELS = 5

/** A repeating job's model for the agent page (read-only): pinned to one, or following the agent's model when it runs. */
export function routineModelText(model: string | null | undefined, agentModel: string | undefined) {
  return model
    ? { model, how: 'pinned' }
    : { model: `its own · ${agentModel ?? 'the agent’s model'}`, how: 'follows the agent' }
}

/** The note under the repeating jobs: what the model shown is, and why it can't be set here. */
export const ROUTINE_MODEL_NOTE =
  'Shown, not set here: a job follows the agent’s model unless it’s pinned. Keep them on the current model when you change the agent’s model.'
