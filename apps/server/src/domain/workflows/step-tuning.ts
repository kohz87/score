import type { DatabaseSync } from 'node:sqlite'
import { WorkflowDefinitionSchema } from '@score/contract'

/**
 * Decision 183: a recipe step's own model and effort, read from the version its run started with. A step without them
 * runs on the agent's own (never a chat's /model); a step of another kind of run has none.
 */
export function stepTuning(
  sqlite: DatabaseSync,
  orchestrationId: string,
  stepId: string | null,
): { model?: string; provider?: string; effort?: string } {
  if (!stepId) return {}
  const row = sqlite
    .prepare(
      `SELECT v.definition, s.node_id FROM wf_steps s
       JOIN wf_runs r ON r.orchestration_id = s.orchestration_id
       JOIN workflow_versions v ON v.workflow_id = r.workflow_id AND v.version = r.version
       WHERE s.orchestration_id = ? AND s.step_id = ?`,
    )
    .get(orchestrationId, stepId) as { definition: string; node_id: string } | undefined
  if (!row) return {}
  const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(row.definition))
  const node = parsed.success
    ? parsed.data.nodes.find((one) => one.id === row.node_id && one.kind === 'agent')
    : undefined
  if (!node || node.kind !== 'agent') return {}
  return {
    ...(node.model ? { model: node.model.model } : {}),
    ...(node.model?.provider ? { provider: node.model.provider } : {}),
    ...(node.effort ? { effort: node.effort } : {}),
  }
}
