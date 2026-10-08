import type { LaneBlock, MessagePart } from '@score/contract'
import { parseMessage } from './parse.ts'

// Plan first (design review 3.4, finding 2): the lead is asked for a Markdown checklist, and Score only reads
// the lines it can attribute to a known agent. Everything else stays plain text and is never started.
export const PLAN_FIRST_ADDENDUM =
  '\n\nPlan first: do not do the work yet. Reply with the plan as a Markdown checklist, one step per line, ' +
  'in the form "- [ ] @agent step". Name exactly one team member on each line.'

export const MAX_PLAN_STEPS = 50
const STEP_LINE = /^ {0,3}[-*] \[ \] (.+)$/u
const FENCE = /^ {0,3}(`{3,}|~{3,})/u

export interface PlanStep {
  agentId: string
  title: string
}

export function parsePlanSteps(text: string, agents: readonly string[]): PlanStep[] {
  const steps: PlanStep[] = []
  let fence: string | null = null
  for (const line of text.split(/\r\n|\n|\r/)) {
    const marker = FENCE.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker[0]!
      else if (marker[0] === fence) fence = null
      continue
    }
    if (fence) continue
    const body = STEP_LINE.exec(line)?.[1]
    if (!body) continue
    const agentId = parseMessage(body, agents).mentions[0]
    if (!agentId) continue
    const title = body
      .replace(
        new RegExp(`(^|\\s)@${agentId.replace(/[^a-z0-9_-]/g, '')}(?![a-z0-9_-])`, 'u'),
        '$1',
      )
      .replace(/\s+/g, ' ')
      .replace(/^[\s,:;-]+/u, '')
      .trim()
      .slice(0, 300)
    if (!title) continue
    steps.push({ agentId, title })
    if (steps.length >= MAX_PLAN_STEPS) break
  }
  return steps
}

export const planBlockId = (briefId: string, index: number) => `plan:${briefId}:${index}`

export function planPart(
  briefId: string,
  steps: readonly PlanStep[],
  now: string,
): Extract<MessagePart, { kind: 'plan' }> | null {
  if (!steps.length) return null
  const lanes = new Map<string, LaneBlock[]>()
  steps.forEach((step, index) => {
    const blocks = lanes.get(step.agentId) ?? []
    blocks.push({
      id: planBlockId(briefId, index),
      label: step.title,
      state: 'planned',
      start: now,
      end: null,
      taskId: null,
      runId: null,
    })
    lanes.set(step.agentId, blocks)
  })
  return {
    kind: 'plan',
    briefId,
    lanes: [...lanes].map(([agentId, blocks]) => ({ agentId, blocks })),
  }
}

/** Steps of a plan part in their original order (block ids end in the step index). */
export function orderedPlanSteps(
  part: Extract<MessagePart, { kind: 'plan' }>,
): { index: number; agentId: string; title: string }[] {
  return part.lanes
    .flatMap((lane) =>
      lane.blocks.flatMap((block) => {
        const index = Number(block.id.slice(block.id.lastIndexOf(':') + 1))
        return Number.isInteger(index) ? [{ index, agentId: lane.agentId, title: block.label }] : []
      }),
    )
    .sort((left, right) => left.index - right.index)
}
