import type { MessageSpeed } from '@score/contract'

/** `first token 1.2 s · 48 tok/s avg · 1,240 tokens`; null when there is nothing measured to show. */
export function speedLine(speed: MessageSpeed | null | undefined): string | null {
  if (!speed) return null
  const parts: string[] = []
  if (speed.ttftMs !== null) parts.push(`first token ${formatTtft(speed.ttftMs)}`)
  if (speed.tokensPerSecond !== null) parts.push(`${formatRate(speed.tokensPerSecond)} tok/s avg`)
  if (speed.outputTokens !== null)
    parts.push(
      `${speed.outputTokens.toLocaleString('en-US')} ${speed.outputTokens === 1 ? 'token' : 'tokens'}`,
    )
  return parts.length ? parts.join(' · ') : null
}

export function formatTtft(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function formatRate(tokensPerSecond: number): string {
  return tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : String(Math.round(tokensPerSecond))
}
