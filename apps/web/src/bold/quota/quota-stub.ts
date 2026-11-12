import { vi } from 'vitest'
import { jsonResponse, mockFetch } from '../room/room-test-utils.tsx'
import { codingRecord } from './quota-test-data.ts'
import type { CodingAgent, CodingQuota } from '@score/contract'

/** What the quota and coding-list endpoints answer; `quota` and `status` can change between reads. */
export type QuotaStub = {
  quota: CodingQuota | null
  quotaStatus: number
  record: CodingAgent | null
  listStatus: number
}

export function stubQuota(initial: Partial<QuotaStub> = {}) {
  const state: QuotaStub = {
    quota: null,
    quotaStatus: 200,
    record: codingRecord(),
    listStatus: 200,
    ...initial,
  }
  const fetchMock = mockFetch((url) => {
    if (url === '/api/coding-agents/builder/quota')
      return state.quotaStatus === 200
        ? jsonResponse({ quota: state.quota })
        : jsonResponse({ error: { code: 'unreadable', message: 'No reading.' } }, state.quotaStatus)
    if (url === '/api/coding-agents')
      return state.listStatus === 200
        ? jsonResponse({ items: state.record ? [state.record] : [] })
        : jsonResponse({ error: { code: 'unreadable', message: 'No list.' } }, state.listStatus)
    return jsonResponse({}, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  const calls = (path: string) =>
    fetchMock.mock.calls.filter(([url]) => String(url) === `/api/${path}`).length
  return { state, fetchMock, calls }
}
