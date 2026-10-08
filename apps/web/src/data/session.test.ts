import { expect, test, vi } from 'vitest'
import { createQueryClient } from './query-client.ts'
import { clearBrowserSession } from './session.ts'

test('logout removes private cached data and cancels outstanding query results', async () => {
  const queryClient = createQueryClient()
  queryClient.setQueryData(['rooms'], { private: 'conversation' })
  const pending = Promise.withResolvers<string>()
  const result = queryClient
    .fetchQuery({ queryKey: ['private'], queryFn: () => pending.promise })
    .catch(() => undefined)
  const close = vi.fn()
  const dispose = vi.fn()
  clearBrowserSession(queryClient, { client: { close }, queries: { dispose } })
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  pending.resolve('late private data')
  await result
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  expect(close).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
})
