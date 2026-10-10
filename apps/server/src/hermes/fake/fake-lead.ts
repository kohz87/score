import type { OrchReceipt } from '@score/contract'
import type { Orchestrator } from '../../domain/orchestration/executor.ts'
import type { ToolName } from '../../domain/orchestration/commands.ts'
import type { FakePort } from './fake-port.ts'

// A scripted lead for the fake adapter (PLAN 7.5a): when a fake run starts and its input is an orchestration lead turn,
// the script calls the `orch.*` tools in-process, exactly as a model would through MCP, using the capability found in
// the input. No model is ever called. Step runs get the fake adapter's ordinary reply.

export interface LeadStep {
  id: string
  status: string
  agent: string
  after: string[]
  instruction: string
}

export interface LeadTurn {
  /** The input as Hermes would receive it (capability included). */
  input: string
  capability: string
  goal: string
  allowedAgents: string[]
  steps: LeadStep[]
  /** Calls a tool as this lead; `commandId` defaults to a fresh one. */
  call(tool: ToolName, args?: Record<string, unknown>, commandId?: string): Promise<LeadCallResult>
}
export type LeadCallResult = OrchReceipt | { status: 'unauthorized'; message: string }
export type LeadScript = (turn: LeadTurn) => Promise<string | void>

const CAPABILITY = /(orc_[A-Za-z0-9_-]{43})/
const stepLine = /^- (s\d+) \[([a-z_]+)(?:: [^\]]*)?\] agent=(\S+)(?: after=(\S+))?(?: replaces=\S+)? result_revision=\d+: (.*)$/

export function parseLeadInput(input: string): Omit<LeadTurn, 'call'> | undefined {
  if (!input.startsWith('You are the lead of a Score orchestration')) return undefined
  const capability = CAPABILITY.exec(input)?.[1]
  if (!capability) return undefined
  const goal = /<<<GOAL\n([\s\S]*?)\nGOAL>>>/.exec(input)?.[1] ?? ''
  const allowed = /^Allowed agents: (.*)\.$/m.exec(input)?.[1]?.split(', ') ?? []
  const steps = input
    .split('\n')
    .flatMap((line) => {
      const match = stepLine.exec(line)
      return match
        ? [{ id: match[1]!, status: match[2]!, agent: match[3]!, after: match[4]?.split(',') ?? [], instruction: match[5]! }]
        : []
    })
  return { input, capability, goal, allowedAgents: allowed, steps }
}

/** Plans two steps, waits for them, finishes. `[fake:ask]` in the goal makes it ask a question first. */
export const defaultLeadScript: LeadScript = async (turn) => {
  const steps = turn.steps
  if (steps.length === 0) {
    if (/\[fake:ask\]/.test(turn.goal) && !/ANSWER q1/.test(turn.input)) {
      await turn.call('orch.ask', { question: 'Which audience is this for?' })
      return 'I asked a question and will continue when it is answered.'
    }
    const first = turn.allowedAgents[0]
    const second = turn.allowedAgents[1] ?? first
    if (!first) return 'No agent to hand work to.'
    await turn.call('orch.plan', { entries: ['Draft the work', 'Review it'] })
    const draft = await turn.call('orch.assign', { agent: first, instruction: `Draft: ${turn.goal.split('\n')[0]}` })
    const id = (draft as OrchReceipt).result?.stepId
    await turn.call('orch.assign', {
      agent: second,
      instruction: 'Review the draft and list problems.',
      ...(typeof id === 'string' ? { after: [id] } : {}),
    })
    await turn.call('orch.note', { text: 'Plan recorded: draft, then review.' })
    return 'I planned two steps and handed them out.'
  }
  const open = steps.filter((step) => ['pending_gate', 'queued', 'admitted', 'unknown'].includes(step.status))
  if (open.length > 0) return 'Waiting for the steps in progress.'
  const bad = steps.filter((step) => ['failed', 'blocked', 'rejected', 'cancelled', 'not_started'].includes(step.status))
  await turn.call('orch.finish', {
    outcome: bad.length ? 'partial' : 'success',
    summary: bad.length ? `Finished with ${bad.length} step(s) not done.` : 'All steps are done.',
  })
  return bad.length ? 'Finished with some steps not done.' : 'Everything is done.'
}

export interface FakeLeadOptions {
  script?: LeadScript
  /** Reply text for a step run (default: the adapter's own reply). */
  stepReply?: (run: { agentId: string; input: string }) => string | undefined
}

let commandCounter = 0

/** Installs the scripted lead on a fake port. Lead turns are told apart by their input, not by agent. */
export function attachFakeLead(port: FakePort, orchestrator: Orchestrator, options: FakeLeadOptions = {}): void {
  const script = options.script ?? defaultLeadScript
  port.runHook = async (run) => {
    const parsed = parseLeadInput(run.input)
    if (!parsed) {
      const reply = options.stepReply?.(run)
      return reply === undefined ? undefined : { text: reply }
    }
    const turn: LeadTurn = {
      ...parsed,
      async call(tool, args = {}, commandId = `fake-${++commandCounter}`) {
        const out = await orchestrator.handleTool(run.agentId, tool, {
          capability: parsed.capability,
          commandId,
          ...args,
        })
        return out.kind === 'receipt' ? out.receipt : { status: 'unauthorized', message: out.message }
      },
    }
    const text = await script(turn)
    return text ? { text } : undefined
  }
}
