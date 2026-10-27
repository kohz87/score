import type { GatePolicy, Trigger, WorkflowDefinition, WorkflowGatePolicy } from '@score/contract'

// The Start a job dialog's pure parts (PLAN 11.10c): titles, When, the policy mappings and the one-step recipe a
// person can save. Kept out of the component so the same rules are easy to test without a browser.

export type When = 'once' | 'schedule' | 'webhook'
export type Ask = 'plan' | 'handoff' | 'risky'
export type StartCheck = {
  key: string
  status: 'ok' | 'fail' | 'pending'
  text: string
  /** 3.7.9: the lead's MCP tools are missing or unknown, so the line offers Reload MCP. */
  reload?: boolean
}

/**
 * The labels are what people pick; the values are what Hermes' scheduler takes (cron, or `every 1h`). The classic
 * Routines tab shows the same placeholder. Sending a label made Hermes reject the routine.
 */
export const SCHEDULES = [
  { label: 'Every weekday at 9:00', value: '0 9 * * 1-5' },
  { label: 'Every Monday at 9:00', value: '0 9 * * 1' },
  { label: 'Every hour', value: 'every 1h' },
] as const

export type ScheduleLabel = (typeof SCHEDULES)[number]['label']

/** The schedule value to send for a label; an unknown label is passed through, as routines may also take cron. */
export function scheduleValue(label: string): string {
  return SCHEDULES.find((option) => option.label === label)?.value ?? label
}

/** A routine's stored schedule as the label people chose, when it is one of them. */
export function scheduleLabel(value: string): string {
  return SCHEDULES.find((option) => option.value === value)?.label ?? value
}

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
 * A datetime-local value (the date and the time the person sees) as the server's ISO deadline. Empty means no
 * deadline. A value that does not parse is no deadline; the form blocks Start instead of sending one.
 */
export function deadlineIso(value: string): string | undefined {
  if (value.trim() === '') return undefined
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
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
