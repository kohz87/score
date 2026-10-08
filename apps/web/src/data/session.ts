import type { QueryClient } from '@tanstack/react-query'
import type { StreamClient } from './stream.ts'
import type { StreamQueryRegistry } from './resync.ts'

export function remoteTransport(): 'http' | 'tls' | undefined {
  const value = document.documentElement.getAttribute('data-score-transport')
  return value === 'http' || value === 'tls' ? value : undefined
}

export function announceLogout(): void {
  window.dispatchEvent(new Event('score:logout'))
}

export function clearBrowserSession(
  queryClient: QueryClient,
  context: { client: Pick<StreamClient, 'close'>; queries: Pick<StreamQueryRegistry, 'dispose'> },
): void {
  context.queries.dispose()
  context.client.close()
  void queryClient.cancelQueries()
  queryClient.clear()
}
