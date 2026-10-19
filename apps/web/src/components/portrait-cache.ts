import { useSyncExternalStore } from 'react'
import { decodePortrait, type DecodedPortrait } from './portrait-decode.ts'
import { petPackUrl } from './pet-pack.ts'

export type PortraitState =
  { status: 'loading' | 'failed' } | ({ status: 'ready'; idle: string } & DecodedPortrait)

type Entry = { state: PortraitState; listeners: Set<() => void> }

// One decode per agent and pack revision for the whole page (PLAN 10.8): every glyph of that agent shares it.
const entries = new Map<string, Entry>()
const LOADING: PortraitState = { status: 'loading' }

function emit(entry: Entry, state: PortraitState) {
  entry.state = state
  for (const listener of entry.listeners) listener()
}

/** The portrait for an agent's pack revision, starting its decode the first time anyone asks. */
export function loadPortrait(agentId: string, rev: string): PortraitState {
  const key = `${agentId}\u0000${rev}`
  let entry = entries.get(key)
  if (!entry) {
    entry = { state: LOADING, listeners: new Set() }
    entries.set(key, entry)
    // A new revision replaces the old one's image.
    for (const [other, old] of entries)
      if (other !== key && other.startsWith(`${agentId}\u0000`) && old.state.status === 'ready') {
        URL.revokeObjectURL(old.state.url)
        entries.delete(other)
      }
    const idle = petPackUrl(agentId, 'idle', rev)
    const current = entry
    decodePortrait(idle).then(
      (decoded) => emit(current, { status: 'ready', idle, ...decoded }),
      () => emit(current, { status: 'failed' }),
    )
  }
  return entry.state
}

export function resetPortraits() {
  for (const entry of entries.values())
    if (entry.state.status === 'ready' && entry.state.url.startsWith('blob:'))
      URL.revokeObjectURL(entry.state.url)
  entries.clear()
}

const NONE: PortraitState = { status: 'failed' }

/** The portrait to draw for an agent, or null while it loads, if it failed, or when the agent has no pack. */
export function usePortrait(
  agentId: string,
  rev: string | null,
): Extract<PortraitState, { status: 'ready' }> | null {
  const key = rev === null ? null : `${agentId}\u0000${rev}`
  const state = useSyncExternalStore(
    (onChange) => {
      if (key === null || rev === null) return () => {}
      loadPortrait(agentId, rev)
      const entry = entries.get(key)
      entry?.listeners.add(onChange)
      return () => entry?.listeners.delete(onChange)
    },
    () => (key === null ? NONE : (entries.get(key)?.state ?? LOADING)),
    () => NONE,
  )
  return state.status === 'ready' ? state : null
}
