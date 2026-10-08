import { QueryClient } from '@tanstack/react-query'
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { StreamClient } from './stream.ts'
import { type StreamQueryDefinition, type StreamQueryRegistry } from './resync.ts'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  })
}

export const StreamContext = createContext<{
  client: StreamClient
  queries: StreamQueryRegistry
} | null>(null)

export function useStream() {
  const context = useContext(StreamContext)
  if (!context) throw new Error('StreamContext is missing')
  return context.client
}

export function useStreamQuery<T>(definition: StreamQueryDefinition<T>) {
  const context = useContext(StreamContext)
  if (!context) throw new Error('StreamContext is missing')
  const handle = context.queries.register(definition)
  return useSyncExternalStore(handle.subscribe, handle.getSnapshot)
}

/** Re-reads a stream query from the server, for state its events cannot derive on their own. */
export function useStreamQueryRefetch<T>(definition: StreamQueryDefinition<T>) {
  const context = useContext(StreamContext)
  if (!context) throw new Error('StreamContext is missing')
  const handle = context.queries.register(definition)
  return handle.refetch
}
