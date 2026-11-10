/** The sections of the agent page, in order: what the left menu (desktop) or the chip row (phone) jumps to. */
export const AGENT_SECTIONS = [
  { id: 'agent-personality', label: 'Personality' },
  { id: 'agent-model', label: 'Model' },
  { id: 'agent-safety', label: 'Safety' },
  { id: 'agent-section-tools', label: 'Tools' },
  { id: 'agent-memory-skills', label: 'Memory and skills' },
  { id: 'agent-work', label: 'Work' },
] as const

export type AgentSectionId = (typeof AGENT_SECTIONS)[number]['id']

/** A coding agent has no memory or skills of its own to manage: its page leaves that section out. */
const CODING_SECTIONS = AGENT_SECTIONS.filter((section) => section.id !== 'agent-memory-skills')

/** The same array each call, so the menu's observer is not rebuilt on every render. */
export function sectionsFor(coding: boolean) {
  return coding ? CODING_SECTIONS : AGENT_SECTIONS
}

/**
 * Links made before the tidy-up point at cards that now sit inside a section or open from a summary. `open` names
 * the card to open in place; `section` is where to scroll when it is not on the page yet.
 */
const HASH_TARGETS: Record<string, { section: AgentSectionId | 'agent-overview'; open?: string }> =
  {
    'agent-memory': { section: 'agent-memory-skills', open: 'memory' },
    'agent-skills': { section: 'agent-memory-skills', open: 'skills' },
    'agent-plugins': { section: 'agent-section-tools', open: 'plugins' },
    'agent-subagents': { section: 'agent-model', open: 'subagents' },
    'agent-workspace': { section: 'agent-work' },
    'agent-files': { section: 'agent-work' },
    'agent-history': { section: 'agent-work', open: 'runs' },
    // The repeating jobs card moved to Tasks (decision 183); the old link lands on Work.
    'agent-routines': { section: 'agent-work' },
    'agent-todo': { section: 'agent-work', open: 'todo' },
    'agent-asks': { section: 'agent-safety', open: 'asks' },
    'agent-where': { section: 'agent-safety', open: 'where' },
    'agent-goes-ahead': { section: 'agent-safety', open: 'goes-ahead' },
    'agent-permissions': { section: 'agent-safety', open: 'never' },
    'agent-channels': { section: 'agent-section-tools', open: 'channels' },
    'agent-score-access': { section: 'agent-section-tools', open: 'score-access' },
    // Name, role and look are behind the header's Edit now, and Remove is in the ⋯ menu and the section menu.
    'agent-details': { section: 'agent-overview' },
    'agent-appearance': { section: 'agent-overview' },
    'agent-delete': { section: 'agent-overview' },
  }

export function hashTarget(hash: string): { id: string; open?: string } | null {
  const id = hash.replace(/^#/, '')
  if (!id.startsWith('agent-')) return null
  const target = HASH_TARGETS[id]
  return target ? { id, open: target.open } : { id }
}

/** Scrolls to an element when the browser can (jsdom cannot). */
export function scrollToId(id: string): boolean {
  const element = document.getElementById(id)
  if (!element) return false
  element.scrollIntoView?.({ block: 'start' })
  return true
}

/** Scrolls to the card, else to the section that holds it. */
export function scrollToTarget(id: string): void {
  if (scrollToId(id)) return
  // A workspace link lands on the Files panel when it is open.
  if ((id === 'agent-workspace' || id === 'agent-files') && scrollToId('agent-files')) return
  const target = HASH_TARGETS[id]
  if (target) scrollToId(target.section)
}
