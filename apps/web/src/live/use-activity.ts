import { useCallback, useContext, useSyncExternalStore } from 'react'
import { StreamContext } from '../data/query-client.ts'
import type { StreamClient } from '../data/stream.ts'
import {
  EMPTY_ACTIVITY,
  reduceActivity,
  setCompacting,
  type ActivityMap,
  type AgentActivity,
} from './activity.ts'
import { statusLine, type StatusInput } from './status-line.ts'

// One store per stream connection, created the first time anything asks (the app shell asks at start, so no event of the
// session is missed).
interface Store {
  get: () => ActivityMap
  subscribe: (listener: () => void) => () => void
  compacting: (agentId: string, value: boolean) => void
}

const stores = new WeakMap<StreamClient, Store>()

function storeFor(client: StreamClient): Store {
  const existing = stores.get(client)
  if (existing) return existing
  let state: ActivityMap = new Map()
  const listeners = new Set<() => void>()
  const set = (next: ActivityMap) => {
    if (next === state) return
    state = next
    listeners.forEach((listener) => listener())
  }
  client.subscribe((event) => set(reduceActivity(state, event)))
  const store: Store = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    compacting: (agentId, value) => set(setCompacting(state, agentId, value)),
  }
  stores.set(client, store)
  return store
}

const NONE: ActivityMap = new Map()

function useActivityMap(): ActivityMap {
  const context = useContext(StreamContext)
  const store = context ? storeFor(context.client) : null
  return useSyncExternalStore(
    store ? store.subscribe : () => () => {},
    store ? store.get : () => NONE,
  )
}

/** Starts listening for the whole session. */
export function useActivityFeed() {
  useActivityMap()
}

export function useAgentActivity(agentId: string | null | undefined): AgentActivity {
  const map = useActivityMap()
  return (agentId ? map.get(agentId) : undefined) ?? EMPTY_ACTIVITY
}

/** Tells the status line that this agent's compaction is under way (or over). */
export function useCompactionMark() {
  const client = useContext(StreamContext)?.client
  return useCallback(
    (agentId: string, value: boolean) => {
      if (client) storeFor(client).compacting(agentId, value)
    },
    [client],
  )
}

/**
 * The status line of an agent: from its own activity, or from the `parts` of a reply when the caller has them (the
 * thread does). Null when the agent is not working; `working` says whether it is, for an agent whose reply isn't known.
 */
export function useStatusLine(
  agentId: string | null | undefined,
  options: { working?: boolean; parts?: StatusInput['parts'] } = {},
): string | null {
  const activity = useAgentActivity(agentId)
  const { working = false, parts } = options
  if (
    !working &&
    activity.messageId === null &&
    activity.typing === null &&
    activity.approvals.size === 0 &&
    !activity.compacting
  )
    return null
  return statusLine({
    waitingForApproval: activity.approvals.size > 0,
    compacting: activity.compacting,
    parts: parts ?? activity.parts,
    typing: activity.typing,
    working,
  })
}

/** Status lines for several agents at once (a room header, a run's diagram): only agents that have one are present. */
export function useStatusLines(
  agents: ReadonlyArray<{ id: string; working: boolean }>,
): Map<string, string> {
  const map = useActivityMap()
  const lines = new Map<string, string>()
  for (const { id, working } of agents) {
    const activity = map.get(id) ?? EMPTY_ACTIVITY
    const line = statusLine({
      waitingForApproval: activity.approvals.size > 0,
      compacting: activity.compacting,
      parts: activity.parts,
      typing: activity.typing,
      working,
    })
    if (line !== null) lines.set(id, line)
  }
  return lines
}
