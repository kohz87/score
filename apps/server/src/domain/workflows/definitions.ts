import {
  WORKFLOW_EXPORT_FORMAT,
  WORKFLOW_LIMITS,
  maxStepsOf,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowExport,
  type WorkflowList,
  type WorkflowSummary,
  type WorkflowVersion,
  type WorkflowVersionSummary,
} from '@score/contract'
import { WorkflowDefinitionSchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact } from '../../redact.ts'
import { isHeld, ownerOfRoom } from '../orchestration/ownership.ts'
import { deleteRoom } from '../room-delete.ts'
import { roomRow } from '../rooms.ts'
import { bytesOf, definitionHash, validateDefinition } from './definition.ts'

// Definitions (contract §15): immutable versions in `workflow_versions`, a mutable header in `workflow_definitions`.
// A version is "used" once any run references it; retained versions are bounded globally (≤ 200 × 20 × 256 KiB).

const HeaderSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().nullable(),
})
const VersionRowSchema = z.object({
  workflow_id: z.string(),
  version: z.int(),
  hash: z.string(),
  definition: z.string(),
  bytes: z.int(),
  created_at: z.string(),
})

/** Versions any run ever used: the irreversible marker, plus (for older rows) the runs still retained. */
const usedVersions = (sqlite: DatabaseSync, id: string): Set<number> =>
  new Set(
    (
      sqlite
        .prepare(
          'SELECT version FROM workflow_versions WHERE workflow_id = ? AND used = 1 UNION SELECT version FROM wf_runs WHERE workflow_id = ?',
        )
        .all(id, id) as { version: number }[]
    ).map((r) => r.version),
  )

function versionSummary(
  row: z.infer<typeof VersionRowSchema>,
  used: Set<number>,
): WorkflowVersionSummary {
  const def = WorkflowDefinitionSchema.parse(JSON.parse(row.definition))
  return {
    version: row.version,
    hash: row.hash,
    createdAt: row.created_at,
    used: used.has(row.version),
    bytes: row.bytes,
    nodes: def.nodes.length,
    maxSteps: maxStepsOf(def),
  }
}

export function readVersion(sqlite: DatabaseSync, id: string, version: number): WorkflowVersion {
  const row = sqlite
    .prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?')
    .get(id, version)
  if (row === undefined)
    throw new HttpError(404, 'not_found', 'Couldn’t find that workflow version.')
  const parsed = VersionRowSchema.parse(row)
  return {
    ...versionSummary(parsed, usedVersions(sqlite, id)),
    workflowId: id,
    definition: WorkflowDefinitionSchema.parse(JSON.parse(parsed.definition)),
  }
}

/** Runs of the recipe that are not finished (a draining run counts). */
const activeRunCount = (sqlite: DatabaseSync, id: string): number =>
  (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM wf_runs w JOIN orchestrations o ON o.id = w.orchestration_id
         WHERE w.workflow_id = ? AND (o.status IN ('running','paused','stopping','finishing')
           OR EXISTS (SELECT 1 FROM orc_attempts a WHERE a.orchestration_id = o.id AND a.state = 'unknown' AND a.abandoned_at IS NULL))`,
      )
      .get(id) as { n: number }
  ).n

function summaryOf(sqlite: DatabaseSync, header: z.infer<typeof HeaderSchema>): WorkflowSummary {
  const versions = z
    .array(VersionRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version')
        .all(header.id),
    )
  const latest = versions.at(-1)!
  const def = WorkflowDefinitionSchema.parse(JSON.parse(latest.definition))
  return {
    id: header.id,
    name: header.name,
    description: header.description,
    latestVersion: latest.version,
    versionCount: versions.length,
    used: usedVersions(sqlite, header.id).size > 0,
    agentIds: [...new Set(def.nodes.flatMap((n) => (n.kind === 'agent' ? [n.agentId] : [])))],
    createdAt: header.created_at,
    updatedAt: header.updated_at,
    activeRuns: activeRunCount(sqlite, header.id),
    archivedAt: header.archived_at,
  }
}

export function listWorkflows(sqlite: DatabaseSync): WorkflowList {
  const headers = z
    .array(HeaderSchema)
    .parse(sqlite.prepare('SELECT * FROM workflow_definitions ORDER BY updated_at DESC, id').all())
  const totals = sqlite
    .prepare('SELECT COUNT(*) AS versions, COALESCE(SUM(bytes), 0) AS bytes FROM workflow_versions')
    .get() as { versions: number; bytes: number }
  return {
    items: headers.map((h) => summaryOf(sqlite, h)),
    inventory: {
      definitions: headers.length,
      versions: totals.versions,
      bytes: totals.bytes,
      maxDefinitions: WORKFLOW_LIMITS.maxDefinitions,
      maxVersionsPerDefinition: WORKFLOW_LIMITS.maxVersionsPerDefinition,
    },
  }
}

export function getWorkflow(sqlite: DatabaseSync, id: string): WorkflowDetail {
  const header = sqlite.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id)
  if (header === undefined) throw new HttpError(404, 'not_found', 'Couldn’t find that workflow.')
  const parsed = HeaderSchema.parse(header)
  const used = usedVersions(sqlite, id)
  const rows = z
    .array(VersionRowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version')
        .all(id),
    )
  return {
    ...summaryOf(sqlite, parsed),
    versions: rows.map((r) => versionSummary(r, used)),
    latest: readVersion(sqlite, id, rows.at(-1)!.version),
  }
}

function requireValid(def: WorkflowDefinition): { hash: string; bytes: number } {
  const result = validateDefinition(def)
  if (!result.ok)
    throw new HttpError(
      422,
      'invalid_definition',
      'The workflow has errors. Fix them and save again.',
      { result },
    )
  return { hash: definitionHash(def), bytes: bytesOf(JSON.stringify(def)) }
}

function checkInventory(sqlite: DatabaseSync, newDefinition: boolean, id: string | null): void {
  if (newDefinition) {
    const n = (
      sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_definitions').get() as { n: number }
    ).n
    if (n >= WORKFLOW_LIMITS.maxDefinitions)
      throw new HttpError(
        409,
        'quota_exhausted',
        `At most ${WORKFLOW_LIMITS.maxDefinitions} workflows are kept.`,
      )
  } else {
    const n = (
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = ?')
        .get(id!) as { n: number }
    ).n
    if (n >= WORKFLOW_LIMITS.maxVersionsPerDefinition)
      throw new HttpError(
        409,
        'quota_exhausted',
        `At most ${WORKFLOW_LIMITS.maxVersionsPerDefinition} versions of a workflow are kept.`,
      )
  }
}

export function createWorkflow(
  sqlite: DatabaseSync,
  def: WorkflowDefinition,
  now: string,
): WorkflowVersion {
  const { hash, bytes } = requireValid(def)
  checkInventory(sqlite, true, null)
  const id = `wf-${randomUUID().slice(0, 8)}`
  sqlite
    .prepare(
      'INSERT INTO workflow_definitions (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, def.name, def.description ?? null, now, now)
  sqlite
    .prepare(
      'INSERT INTO workflow_versions (workflow_id, version, hash, definition, bytes, created_at) VALUES (?, 1, ?, ?, ?, ?)',
    )
    .run(id, hash, JSON.stringify(def), bytes, now)
  return readVersion(sqlite, id, 1)
}

export function addVersion(
  sqlite: DatabaseSync,
  id: string,
  baseVersion: number,
  def: WorkflowDefinition,
  now: string,
): WorkflowVersion {
  const header = sqlite.prepare('SELECT 1 FROM workflow_definitions WHERE id = ?').get(id)
  if (header === undefined) throw new HttpError(404, 'not_found', 'Couldn’t find that workflow.')
  const latest = (
    sqlite
      .prepare('SELECT MAX(version) AS v FROM workflow_versions WHERE workflow_id = ?')
      .get(id) as { v: number }
  ).v
  if (latest !== baseVersion)
    throw new HttpError(
      409,
      'conflict',
      'A newer version of this workflow was saved. Reload it first.',
      {
        latestVersion: latest,
      },
    )
  const { hash, bytes } = requireValid(def)
  checkInventory(sqlite, false, id)
  sqlite
    .prepare(
      'INSERT INTO workflow_versions (workflow_id, version, hash, definition, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, latest + 1, hash, JSON.stringify(def), bytes, now)
  sqlite
    .prepare(
      'UPDATE workflow_definitions SET name = ?, description = ?, updated_at = ? WHERE id = ?',
    )
    .run(def.name, def.description ?? null, now, id)
  return readVersion(sqlite, id, latest + 1)
}

export function deleteWorkflow(sqlite: DatabaseSync, id: string): void {
  if (sqlite.prepare('SELECT 1 FROM workflow_definitions WHERE id = ?').get(id) === undefined)
    throw new HttpError(404, 'not_found', 'Couldn’t find that workflow.')
  if (usedVersions(sqlite, id).size > 0)
    throw new HttpError(409, 'workflow_used', 'This workflow has runs, so it can’t be deleted.')
  sqlite.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(id)
  sqlite.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id)
}

/** Archive or unarchive (3.8.0): hides the recipe from the list and Start a job; its runs are untouched. */
export function setWorkflowArchived(
  sqlite: DatabaseSync,
  id: string,
  archived: boolean,
  now: string,
): WorkflowSummary {
  const header = sqlite.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id)
  if (header === undefined) throw new HttpError(404, 'not_found', 'Couldn’t find that workflow.')
  const parsed = HeaderSchema.parse(header)
  // Archiving twice keeps the first time.
  const archivedAt = archived ? (parsed.archived_at ?? now) : null
  sqlite.prepare('UPDATE workflow_definitions SET archived_at = ? WHERE id = ?').run(archivedAt, id)
  return summaryOf(sqlite, { ...parsed, archived_at: archivedAt })
}

/**
 * Deletes a recipe and every run of it (3.8.0), in the caller's transaction: each run's room goes the way deleting
 * the room does, then the versions and the definition. Refused while a run is going.
 */
export function deleteWorkflowWithRuns(
  sqlite: DatabaseSync,
  id: string,
  confirm: string,
  now: string,
): { deletedRuns: number; events: DomainEventDraft[] } {
  const header = sqlite.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id)
  if (header === undefined) throw new HttpError(404, 'not_found', 'Couldn’t find that workflow.')
  const parsed = HeaderSchema.parse(header)
  if (confirm.trim() !== parsed.name.trim())
    throw new HttpError(400, 'bad_request', 'Type the recipe’s name to delete it.')
  const stillGoing = () =>
    new HttpError(409, 'run_active', 'A run of this recipe is still going. Stop it first.')
  if (activeRunCount(sqlite, id) > 0) throw stillGoing()
  const runs = sqlite
    .prepare(
      `SELECT o.room_id AS room_id FROM wf_runs w JOIN orchestrations o ON o.id = w.orchestration_id
       WHERE w.workflow_id = ?`,
    )
    .all(id) as { room_id: string | null }[]
  // A finished run can still be draining (a stop not yet acknowledged): its room is held like a running one.
  for (const { room_id } of runs)
    if (room_id !== null && isHeld(ownerOfRoom(sqlite, room_id))) throw stillGoing()
  const events: DomainEventDraft[] = []
  for (const { room_id } of runs) {
    if (room_id === null) continue
    try {
      events.push(...deleteRoom(sqlite, room_id, roomRow(sqlite, room_id).name, now))
    } catch (error) {
      // The caller's transaction rolls back, so nothing earlier in the loop stays deleted.
      if (
        error instanceof HttpError &&
        (error.code === 'orchestration_owned' || error.code === 'room_busy')
      )
        throw stillGoing()
      throw error
    }
  }
  sqlite.prepare('DELETE FROM wf_runs WHERE workflow_id = ?').run(id)
  sqlite.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(id)
  sqlite.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id)
  return { deletedRuns: runs.length, events }
}

// -------------------------------------------------------------------------------------------------------- export

export interface AgentDescriptor {
  name: string
  role: string | null
}

/** Every free-text field passes `redact()`; what changed is listed; removed paths become "[removed]"; revalidated. */
export function exportVersion(
  version: WorkflowVersion,
  describe: (agentId: string) => AgentDescriptor,
  removePaths: readonly string[],
): WorkflowExport {
  const changes: WorkflowExport['changes'] = []
  const removed = new Set(removePaths)
  const clean = (path: string, text: string): string => {
    if (removed.has(path)) {
      if (text !== '[removed]') changes.push({ path, before: text, after: '[removed]' })
      return '[removed]'
    }
    const after = redact(text)
    if (after !== text) changes.push({ path, before: text, after })
    return after
  }
  const def = version.definition
  const portable: WorkflowExport['portable'] = {
    name: clean('name', def.name),
    ...(def.description === undefined
      ? {}
      : { description: clean('description', def.description) }),
    inputs: def.inputs.map((input, i) => ({
      ...input,
      label: clean(`inputs[${i}].label`, input.label),
    })),
    nodes: def.nodes.map((node, i) => {
      const base = `nodes[${i}]`
      switch (node.kind) {
        case 'agent': {
          const { agentId, ...rest } = node
          return {
            ...rest,
            label: clean(`${base}.label`, node.label),
            instruction: clean(`${base}.instruction`, node.instruction),
            agent: describe(agentId),
          }
        }
        case 'gate':
          return {
            ...node,
            label: clean(`${base}.label`, node.label),
            question: clean(`${base}.question`, node.question),
          }
        case 'branch':
          return {
            ...node,
            label: clean(`${base}.label`, node.label),
            rules: node.rules.map((rule, r) =>
              rule.when.kind === 'output_contains'
                ? {
                    ...rule,
                    when: {
                      ...rule.when,
                      text: clean(`${base}.rules[${r}].when.text`, rule.when.text),
                    },
                  }
                : rule,
            ),
          }
        default:
          return { ...node, label: clean(`${base}.label`, node.label) }
      }
    }),
    edges: def.edges,
    ...(def.layout === undefined ? {} : { layout: def.layout }),
  }
  // Revalidate the scrubbed graph with stand-in agent ids (the descriptors carry no local identity).
  const stand: WorkflowDefinition = {
    name: portable.name,
    ...(portable.description === undefined ? {} : { description: portable.description }),
    inputs: portable.inputs,
    edges: portable.edges,
    ...(portable.layout === undefined ? {} : { layout: portable.layout }),
    nodes: portable.nodes.map((node) => {
      if (!('agent' in node)) return node
      const { agent, ...rest } = node
      return { ...rest, agentId: `agent:${agent.name}` }
    }),
  }
  return {
    format: WORKFLOW_EXPORT_FORMAT,
    scrubbed: true,
    workflowId: version.workflowId,
    version: version.version,
    portable,
    changes,
    validation: validateDefinition(stand),
  }
}
