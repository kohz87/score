import type { QueryClient } from '@tanstack/react-query'
import type { StreamClient } from './stream.ts'
import type { StreamQueryRegistry } from './resync.ts'

// Remote mode is HTTPS-only: the server marks the page 'tls'; local mode has no marker.
export function remoteTransport(): 'tls' | undefined {
  return document.documentElement.getAttribute('data-score-transport') === 'tls' ? 'tls' : undefined
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
