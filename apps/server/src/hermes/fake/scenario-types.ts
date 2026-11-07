import type { DomainEventDraft } from '../../hub/ingest.ts'

export type ScenarioStep = {
  [T in DomainEventDraft['type']]: {
    at: number
    kind: T
    data: Extract<DomainEventDraft, { type: T }>['data']
  }
}[DomainEventDraft['type']]
