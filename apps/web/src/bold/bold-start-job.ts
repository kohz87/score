import type {
  GatePolicy,
  Trigger,
  WorkflowDefinition,
  WorkflowGatePolicy,
} from '@score/contract'

// The Start a job dialog's pure parts (PLAN 11.10c): titles, When, the policy mappings and the one-step recipe a
// person can save. Kept out of the component so the same rules are easy to test without a browser.

export type When = 'once' | 'schedule' | 'webhook'
export type Ask = 'plan' | 'handoff' | 'risky'
export type StartCheck = {
  key: string
  status: 'ok' | 'fail' | 'pending'
  text: string
}

export const SCHEDULES = ['Every weekday at 9:00', 'Every Monday at 9:00', 'Every hour'] as const

/** The job's name: the first line of what the person asked for, bounded like a job title. */
export function titleOf(what: string): string {
  const first = what.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return (first || 'New job').slice(0, 200)
}

/** A short title for an orchestration, whose contract allows fewer characters than a job. */
export function orchestrationTitleOf(what: string): string {
  return titleOf(what).slice(0, 120)
}

/** The trigger's name; the form may override it, but an empty field still makes a useful name from the request. */
export function triggerNameOf(name: string, what: string): string {
  return (name.trim() || titleOf(what)).slice(0, 100)
}

/**
 * The prototype asks for a time, not a date. A time already passed means tomorrow's, so the run never starts with a
 * deadline in the past (which the server would refuse). An empty time means no deadline.
 */
export function deadlineIso(time: string, now = new Date()): string | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  const at = new Date(now)
  at.setHours(hours, minutes, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at.toISOString()
}

/** The three plain-words ask choices map onto the orchestrator's gate policies. Risky actions stay Hermes' own gate. */
export function orchestrationPolicy(ask: Ask): GatePolicy {
  if (ask === 'plan') return 'every-step'
  if (ask === 'handoff') return 'lead-asks'
  return 'none'
}

/** A workflow has no lead to ask: "the plan starts" is the every-step gate, everything else is gates only. */
export function workflowPolicy(ask: Ask): WorkflowGatePolicy {
  return ask === 'plan' ? 'every-step' : 'gates-only'
}

/**
 * "Save as a recipe" saves the step this dialog can honestly describe: one agent step with the request as its
 * instruction. Saved recipes that differ are drawn in the recipe editor (11.10d), not invented here.
 */
export function oneStepRecipe(input: {
  name: string
  instruction: string
  agentId: string
}): WorkflowDefinition {
  const name = input.name.trim().slice(0, 120) || 'Saved from Start a job'
  const instruction = input.instruction.trim().slice(0, 32_000) || 'Do the work.'
  return {
    name,
    description: 'Saved from Start a job.',
    inputs: [],
    nodes: [
      {
        id: 'work',
        kind: 'agent',
        label: 'Do the work',
        agentId: input.agentId,
        instruction,
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [{ id: 'work_done', from: 'work', port: 'ok', to: 'done' }],
  }
}

/**
 * The trigger this dialog can make without the four-step mapping wizard's sample call: the app sends `ref`, and may
 * send `title`, `link` and `details`. The request itself is the job's instruction; results stay in Score.
 */
export function triggerRequest(input: {
  name: string
  app: string
  what: string
}): Pick<Trigger, 'name' | 'app' | 'mapping' | 'template' | 'reportBack'> {
  return {
    name: triggerNameOf(input.name, input.what),
    app: input.app.trim().slice(0, 100) || 'Another app',
    mapping: { ref: 'ref', title: 'title', link: 'link', details: 'details' },
    template: input.what.trim().slice(0, 4000) || 'Do the work.',
    reportBack: { mode: 'off' },
  }
}
