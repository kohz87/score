import type { AgentSummary, Job, WorkbenchComment, WorkbenchFile } from '@score/contract'
import type { WorkbenchTab } from './bold-links.ts'

export type BenchTab = Extract<WorkbenchTab, 'code' | 'screen' | 'draft'>
export type JobFace = Pick<Job, 'id' | 'title' | 'state'>

export const COMMENT_LABEL: Record<WorkbenchComment['kind'], string> = {
  review: 'Review note',
  approve: 'Approved',
  send_back: 'Sent back',
}

export const commentLine = (comment: WorkbenchComment): number | null => comment.line

export function agentsOfFile(file: WorkbenchFile): string[] {
  return [...new Set([...file.editedBy, ...file.cursors.map((cursor) => cursor.agentId)])].sort()
}

/** The agent a tab takes its colour from: the one that edited last, else the first author. */
export function fileAgent(file: WorkbenchFile): string | undefined {
  const cursor = [...file.cursors].sort((a, b) => b.at.localeCompare(a.at))[0]
  return cursor?.agentId ?? agentsOfFile(file)[0]
}

export function party(agents: Map<string, AgentSummary>, agentId: string | undefined) {
  return agentId ? agents.get(agentId) : undefined
}

/** The nearest line Score saw, for a cursor whose own line is missing from the file snapshot. */
export function nearestLine(lines: WorkbenchFile['lines'], line: number): number | null {
  let nearest: number | null = null
  for (const candidate of lines) {
    if (
      nearest === null ||
      Math.abs(candidate.n - line) < Math.abs(nearest - line) ||
      (Math.abs(candidate.n - line) === Math.abs(nearest - line) && candidate.n < nearest)
    )
      nearest = candidate.n
  }
  return nearest
}
