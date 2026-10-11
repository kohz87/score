import { AgentContextSchema, type AgentContext } from '@score/contract'
import { apiFetch } from '../../data/api.ts'

export const agentContextKey = (agentId: string) => ['chat', 'context', agentId] as const

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

/** Share of the context window used, or null when either side is unknown. */
export function meterFraction(context: AgentContext): number | null {
  if (!context.tokens || !context.contextLength) return null
  return Math.min(1, (context.tokens.input + context.tokens.output) / context.contextLength)
}

/** The local card for `/usage`. */
export function usageSummary(name: string, context: AgentContext): string {
  const text = meterText(context)
  if (!text) return `${name} has not reported any usage yet.`
  const lines = [`${name}: ${text}`]
  if (context.tokens)
    lines.push(
      `Input ${context.tokens.input.toLocaleString()} · output ${context.tokens.output.toLocaleString()}`,
    )
  if (context.model) lines.push(`Model ${context.model}`)
  return lines.join('\n')
}

export type LocalCommand =
  { kind: 'compress' } | { kind: 'usage' } | { kind: 'model'; model: string }

/** Commands the web app handles itself; everything else goes to the server as before. */
export function parseLocalCommand(text: string): LocalCommand | null {
  const body = text.trim()
  if (/^\/compress$/i.test(body)) return { kind: 'compress' }
  if (/^\/usage$/i.test(body)) return { kind: 'usage' }
  const model = /^\/model\s+(\S+)$/i.exec(body)
  return model ? { kind: 'model', model: model[1]! } : null
}

export const LOCAL_COMMAND_MENU = [
  { name: 'compress', usage: '/compress', description: 'Compact this agent’s session.' },
  { name: 'usage', usage: '/usage', description: 'Show tokens and cost for this agent.' },
]
