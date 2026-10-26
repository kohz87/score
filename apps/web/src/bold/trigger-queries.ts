import {
  TriggerCreatedSchema,
  TriggerCreateRequestSchema,
  TriggerSchema,
  TriggerSecretSchema,
  TriggersResponseSchema,
  TriggerUpdateRequestSchema,
  type ReportBack,
  type Trigger,
  type TriggerMapping,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../data/api.ts'
import { newId } from '../data/ids.ts'

export const triggersKey = ['settings', 'triggers'] as const

export type TriggerCreateRequest = {
  name: string
  app: string
  mapping: TriggerMapping
  template: string
  reportBack: ReportBack
  teamRoomId?: string | null
}
export type TriggerUpdateRequest = Partial<TriggerCreateRequest>

export function useTriggers(polling = false) {
  return useQuery({
    queryKey: triggersKey,
    queryFn: async ({ signal }) =>
      TriggersResponseSchema.parse(await apiFetch('triggers', { signal })).items,
    retry: false,
    refetchInterval: polling ? 1_500 : false,
  })
}

/**
 * Creation and rotation answer with the one-time secret. These are deliberately plain calls, not query-client
 * mutations: the secret belongs in component state until its card closes, never in a cache.
 */
export async function createTrigger(request: TriggerCreateRequest) {
  const body = TriggerCreateRequestSchema.parse(request)
  return TriggerCreatedSchema.parse(
    await apiFetch('triggers', {
      method: 'POST',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify(body),
    }),
  )
}

export async function updateTrigger(id: string, request: TriggerUpdateRequest): Promise<Trigger> {
  const body = TriggerUpdateRequestSchema.parse(request)
  return TriggerSchema.parse(
    await apiFetch(`triggers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  )
}

export async function deleteTrigger(id: string): Promise<void> {
  await apiFetch(`triggers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function showTriggerSecret(id: string): Promise<string> {
  return TriggerSecretSchema.parse(await apiFetch(`triggers/${encodeURIComponent(id)}/secret`))
    .secret
}

export async function rotateTrigger(id: string): Promise<string> {
  return TriggerSecretSchema.parse(
    await apiFetch(`triggers/${encodeURIComponent(id)}/rotate`, { method: 'POST' }),
  ).secret
}
