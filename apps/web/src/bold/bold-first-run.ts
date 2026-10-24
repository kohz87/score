import type {
  SystemStatus,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowInput,
  WorkflowNode,
} from '@score/contract'

export const FIRST_RUN_DONE_KEY = 'score.bold.first-run.done'

export type FirstRunRoom = { leadAgentId: string | null }

/** The automatic screen waits for the room; an explicit `?first=run` always wins. */
export function shouldShowFirstRun(
  forced: boolean,
  finished: boolean,
  room: FirstRunRoom | null | undefined,
): boolean {
  return forced || (!finished && room !== null && room !== undefined && room.leadAgentId === null)
}

export function firstRunDone(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_DONE_KEY) === '1'
  } catch {
    return false
  }
}

export function finishFirstRun(): void {
  try {
    window.localStorage.setItem(FIRST_RUN_DONE_KEY, '1')
  } catch {
    // A browser that refuses storage still finishes; the team room's lead keeps the automatic screen away.
  }
}

export type HermesCopy = {
  title: string
  detail: string
  trouble: string | null
  ok: boolean
}

export function hermesStatusCopy(status: SystemStatus | undefined, failed: boolean): HermesCopy {
  if (failed)
    return {
      title: 'Couldn’t check Hermes',
      detail: 'Score couldn’t read the Hermes status from this server.',
      trouble: 'Open the setup help if this keeps happening.',
      ok: false,
    }
  if (!status)
    return {
      title: 'Checking Hermes…',
      detail: 'Reading its version, gateway and bridge.',
      trouble: null,
      ok: false,
    }

  const trouble = [...status.degraded]
  if (!status.hermes.reachable) trouble.unshift('Score can’t reach Hermes on this machine.')
  if (!status.hermes.apiServer) trouble.push('The Hermes gateway is not running.')

  const version = status.hermes.version
    ? `Version ${status.hermes.version}`
    : 'Version not reported'
  const gateway = status.hermes.apiServer ? 'gateway running' : 'gateway not running'
  const producers = status.bridge.producers
  const bridge =
    producers === 0
      ? 'Bridge waiting for a producer'
      : `Bridge connected (${producers} producer${producers === 1 ? '' : 's'})`

  return {
    title: !status.hermes.reachable
      ? 'Hermes not found'
      : trouble.length > 0
        ? 'Hermes found, but it needs attention'
        : 'Hermes found',
    detail: `${version}, ${gateway}. ${bridge}.`,
    trouble: trouble.length > 0 ? trouble.join(' ') : null,
    ok: status.hermes.reachable && trouble.length === 0,
  }
}

export type StarterRole = 'lead' | 'builder' | 'reviewer' | 'designer'

export type StarterRecipe = {
  id: 'build-review' | 'write-review-design' | 'research-report'
  name: string
  description: string
  agents: StarterRole[]
  build: (agentId: (role: StarterRole) => string) => WorkflowDefinition
}

const input = (name: string, label: string): WorkflowInput => ({
  name,
  label,
  required: true,
  maxChars: 4_000,
})

const agent = (
  id: string,
  label: string,
  agentId: string,
  instruction: string,
  retries: number,
): WorkflowNode => ({
  id,
  kind: 'agent',
  label,
  agentId,
  instruction,
  retries,
  onFailure: 'fail_run',
})

const edge = (id: string, from: string, port: string, to: string): WorkflowEdge => ({
  id,
  from,
  port,
  to,
})

export const starterRecipes: readonly StarterRecipe[] = [
  {
    id: 'build-review',
    name: 'Build, then review',
    description: 'builder makes it, reviewer checks it',
    agents: ['builder', 'reviewer'],
    build: (id) => ({
      name: 'Build, then review',
      description: 'builder makes it, reviewer checks it',
      inputs: [input('goal', 'What to build')],
      nodes: [
        agent(
          'build',
          'Build it',
          id('builder'),
          'Build {{inputs.goal}}. Make small, tested changes.',
          1,
        ),
        agent(
          'review',
          'Review it',
          id('reviewer'),
          'Review the change from {{nodes.build.output}}. End with a verdict.',
          0,
        ),
        {
          id: 'passed',
          kind: 'branch',
          label: 'Passed?',
          subject: 'review',
          rules: [{ id: 'passed', when: { kind: 'verdict', is: 'passed' } }],
        },
        {
          id: 'ok',
          kind: 'gate',
          label: 'Your OK before merging',
          question: 'Is this change ready to merge?',
          onReject: 'stop_run',
        },
        { id: 'end', kind: 'end', label: 'Done' },
      ],
      edges: [
        edge('build-review', 'build', 'ok', 'review'),
        edge('review-passed', 'review', 'ok', 'passed'),
        edge('passed-ok', 'passed', 'passed', 'ok'),
        edge('passed-end', 'passed', 'default', 'end'),
        edge('ok-end', 'ok', 'ok', 'end'),
      ],
    }),
  },
  {
    id: 'write-review-design',
    name: 'Write, review, design',
    description: 'lead writes, reviewer checks, designer draws',
    agents: ['lead', 'reviewer', 'designer'],
    build: (id) => ({
      name: 'Write, review, design',
      description: 'lead writes, reviewer checks, designer draws',
      inputs: [input('topic', 'What to write about')],
      nodes: [
        agent('write', 'Write the draft', id('lead'), 'Write about {{inputs.topic}}.', 0),
        agent(
          'review',
          'Review the draft',
          id('reviewer'),
          'Review the draft from {{nodes.write.output}}. Send it back with clear notes until it is right.',
          0,
        ),
        agent(
          'design',
          'Draw the image',
          id('designer'),
          'Draw an announcement image for {{inputs.topic}}.',
          1,
        ),
        { id: 'join', kind: 'join', label: 'Wait for both', mode: 'all' },
        { id: 'end', kind: 'end', label: 'Done' },
      ],
      edges: [
        edge('write-review', 'write', 'ok', 'review'),
        edge('write-design', 'write', 'ok', 'design'),
        edge('review-join', 'review', 'ok', 'join'),
        edge('design-join', 'design', 'ok', 'join'),
        edge('join-end', 'join', 'ok', 'end'),
      ],
    }),
  },
  {
    id: 'research-report',
    name: 'Research report',
    description: 'A short summary with sources',
    agents: ['lead'],
    build: (id) => ({
      name: 'Research report',
      description: 'A short summary with sources',
      inputs: [input('question', 'Question to answer')],
      nodes: [
        agent(
          'research',
          'Research',
          id('lead'),
          'Answer {{inputs.question}} with sources.',
          0,
        ),
        { id: 'end', kind: 'end', label: 'Done' },
      ],
      edges: [edge('research-end', 'research', 'ok', 'end')],
    }),
  },
] as const

/** A recipe can be saved only when every agent it needs is on the team; the team's ids are used unchanged. */
export function starterDefinition(
  recipe: StarterRecipe,
  members: readonly string[],
): WorkflowDefinition | null {
  const available = new Set(members)
  if (!recipe.agents.every((role) => available.has(role))) return null
  return recipe.build((role) => role)
}

export function starterMissing(recipe: StarterRecipe, members: readonly string[]): StarterRole[] {
  const available = new Set(members)
  return recipe.agents.filter((role) => !available.has(role))
}
