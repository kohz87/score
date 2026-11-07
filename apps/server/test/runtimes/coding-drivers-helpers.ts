import type { CodingEvent } from '../../src/runtimes/coding/types.ts'
import { createCodexParser } from '../../src/runtimes/coding/codex.ts'
import { fixtureLines } from './coding-fixtures.ts'

export const parseAll = (parser: { parse(line: string): CodingEvent[] }, name: string) =>
  fixtureLines(name).flatMap((line) => parser.parse(line))

export const deny = ['/home/u/.hermes', '/home/u/.score', '/home/u/.ssh']
export const base = {
  workspace: '/ws',
  prompt: '',
  model: null,
  sessionId: null,
  settingsPath: null,
  denyPaths: deny,
  denyFiles: [],
}

export const verdictOf = (events: CodingEvent[]) =>
  (events.findLast((event) => event.kind === 'result') as Extract<CodingEvent, { kind: 'result' }>)
    ?.verdict

export const claudeResult = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: 'result', ...fields })

export const codexLine = (value: unknown) => JSON.stringify(value)
export const agentMessage = (id: string, text: unknown, type = 'item.completed') =>
  codexLine({ type, item: { id, type: 'agent_message', text } })
export const turnCompleted = codexLine({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
})

export const runCodex = (lines: string[]) => {
  const parser = createCodexParser()
  const events = lines.flatMap((line) => parser.parse(line))
  return { events, verdict: verdictOf(events), lost: parser.lossReason?.() ?? null }
}
export const finalMessage = agentMessage('m1', 'All done.')
