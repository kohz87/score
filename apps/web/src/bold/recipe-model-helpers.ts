import type { WorkflowDefinition } from '@score/contract'
// The test checks the editor's graph against the one validator save and start use.
// eslint-disable-next-line no-restricted-imports
import { validateDefinition } from '../../../../apps/server/src/domain/workflows/definition.ts'
import {
  codingDefinition,
  drawnDefinition,
  failureRouteDefinition,
  gateRejectDefinition,
  joinDefinition,
  releaseDefinition,
  unfinishedDefinition,
} from '../../../../e2e/workflow-fixtures.ts'
import type { Draft } from '../routes/workflows/workflow-model.ts'

export const fixtures: [string, WorkflowDefinition][] = [
  ['release', releaseDefinition],
  ['unfinished', unfinishedDefinition],
  ['drawn', drawnDefinition],
  ['coding', codingDefinition],
  ['failure route', failureRouteDefinition],
  ['gate reject route', gateRejectDefinition],
  ['join', joinDefinition],
]

export function canonical(definition: Draft) {
  return {
    ...definition,
    nodes: [...definition.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...definition.edges].sort((a, b) =>
      `${a.from}/${a.port}/${a.to}/${a.id}`.localeCompare(`${b.from}/${b.port}/${b.to}/${b.id}`),
    ),
  }
}

export function validationAnswer(definition: WorkflowDefinition) {
  const result = validateDefinition(definition)
  return {
    ok: result.ok,
    // Relinking a short id to a longer one changes the serialised byte count without changing the answer.
    stats: { ...result.stats, bytes: 0 },
    issues: result.issues
      .map((issue) => ({ ...issue }))
      .sort((a, b) =>
        `${a.code}/${a.nodeId ?? ''}/${a.edgeId ?? ''}/${a.field ?? ''}/${a.message}`.localeCompare(
          `${b.code}/${b.nodeId ?? ''}/${b.edgeId ?? ''}/${b.field ?? ''}/${b.message}`,
        ),
      ),
  }
}
