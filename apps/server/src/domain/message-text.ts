import type { MessagePart } from '@score/contract'

// What of a message an agent reads (PLAN 11.2): its text parts, and a copy shared from a one-to-one, quoted and labelled
// so the agent knows it is a copy of someone else's words. Kept free of imports so every input builder can use it.

export function agentText(parts: MessagePart[]): string {
  return parts
    .flatMap((part) => {
      if (part.kind === 'text') return [part.text]
      if (part.kind === 'shared')
        return [
          `(shared from a one-to-one${part.from.agentId ? ` with ${part.from.agentId}` : ''}, quoted)\n${part.text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')}`,
        ]
      return []
    })
    .join('\n')
}
