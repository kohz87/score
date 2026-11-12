import {
  AgentContextSchema,
  type AgentContext,
  type CodingQuota,
  type CodingRuntime,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { planLabel, quotaReadLine, quotaUsageLines } from '../team/quota-view.ts'

export async function fetchAgentContext(agentId: string): Promise<AgentContext> {
  return AgentContextSchema.parse(await apiFetch(`agents/${encodeURIComponent(agentId)}/context`))
}

export const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
      : String(value)

export function meterText(context: AgentContext): string | null {
  if (!context.tokens) return null
  const used = context.tokens.input + context.tokens.output
  const window = context.contextLength ? ` of ${compact(context.contextLength)}` : ''
  const cost = context.costUsd === null ? '' : ` · $${context.costUsd.toFixed(4)}`
  return `${compact(used)}${window} tokens${cost}`
}

/** The local card for `/usage`. */
export function usageSummary(name: string, context: AgentContext): string {
  const text = meterText(context)
  if (!text) return `${name} hasn’t reported any usage yet.`
  const lines = [`${name}: ${text}`]
  if (context.tokens)
    lines.push(
      `Input ${context.tokens.input.toLocaleString()} · output ${context.tokens.output.toLocaleString()}`,
    )
  if (context.model) lines.push(`Model ${context.model}`)
  return lines.join('\n')
}

/** `/usage` and `/status` for a coding agent: the same session lines, then its plan's own windows. */
export function codingUsageSummary(
  name: string,
  context: AgentContext,
  quota: CodingQuota | null | undefined,
  runtime: CodingRuntime,
  now = new Date(),
): string {
  const lines = [usageSummary(name, context)]
  if (context.costUsd === null) lines.push('Plan usage, so no dollar cost')
  lines.push('', `${planLabel(runtime).toUpperCase()} QUOTA`)
  if (quota === undefined) lines.push('Quota couldn’t be read.')
  else if (quota === null) lines.push('Quota · shows after its first turn.')
  else if (quota.windows.length === 0) lines.push('Quota · not reported.')
  else {
    lines.push(...quotaUsageLines(quota, now))
    const read = quotaReadLine(quota, now)
    lines.push(`${read.charAt(0).toUpperCase()}${read.slice(1)}.`)
  }
  return lines.join('\n')
}

export type LocalCommand =
  { kind: 'compress' } | { kind: 'usage' } | { kind: 'model'; model: string }

/**
 * Commands the web app handles itself; everything else goes to the server as before. `/status` is a coding agent's
 * alias for `/usage`; a Hermes agent never has it.
 */
export function parseLocalCommand(text: string, codingAgent = false): LocalCommand | null {
  const body = text.trim()
  if (/^\/compress$/i.test(body)) return { kind: 'compress' }
  if (/^\/usage$/i.test(body)) return { kind: 'usage' }
  if (codingAgent && /^\/status$/i.test(body)) return { kind: 'usage' }
  const model = /^\/model\s+(\S+)$/i.exec(body)
  return model ? { kind: 'model', model: model[1]! } : null
}

export const LOCAL_COMMAND_MENU = [
  { name: 'compress', usage: '/compress', description: 'Compact this agent’s session.' },
  { name: 'usage', usage: '/usage', description: 'Show tokens and cost for this agent.' },
  { name: 'status', usage: '/status', description: 'Show tokens, context and plan quota' },
]

/** The `/` rows for this agent: Hermes keeps `/usage`; only a coding agent is offered `/status`. */
export function localCommandMenu(codingAgent: boolean) {
  return LOCAL_COMMAND_MENU.filter((item) => codingAgent || item.name !== 'status').map((item) =>
    codingAgent && (item.name === 'usage' || item.name === 'status')
      ? { ...item, description: 'Show tokens, context and plan quota' }
      : item,
  )
}
