import type { BridgeEvent } from '@score/contract'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redactBounded } from '../../redact.ts'
import type { Producer } from './registry.ts'

type LogKind = 'tool' | 'approval' | 'message' | 'system'
export type BridgeLog = (kind: LogKind, text: string) => DomainEventDraft

export function createBridgeLog(
  identity: string,
  event: BridgeEvent,
  producer: Producer,
): BridgeLog {
  return (kind, text) => ({
    type: 'log.line',
    data: {
      id: identity,
      at: event.at,
      agentId: producer.profile,
      kind,
      text: redactBounded(text, 2048),
    },
  })
}
