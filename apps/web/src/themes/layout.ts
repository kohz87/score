import { ThemeManifestSchema, type ThemeManifest } from '@score/contract'
import { useSyncExternalStore } from 'react'
import { destinations } from '../shell/destinations.ts'

// The layout model (PLAN 9.3, design docs/briefs/9-themes.md §7): what a theme's `layout` asks of the components that
// can't be done with an attribute and CSS alone (menu order and labels, the Now cards, the chat options). It is
// resolved here, once, into a plain config with the defaults filled in and the protected parts enforced (Settings
// and Needs-you can't be left out). The engine publishes it after a theme was applied; components read it with
// useLayout(). Until then, and in safe mode or after a skipped theme, every component sees the Score default.

export type Look = Pick<ThemeManifest, 'colors' | 'fonts' | 'shape' | 'layout' | 'background'>
export type LookView = 'admin' | 'user'
type Layout = NonNullable<ThemeManifest['layout']>

export type Nav = NonNullable<Layout['nav']>
export type NowCardKind = NonNullable<Layout['now']>['cards'][number]['card']
export type NowArrangement = { columns: number; cards: { card: NowCardKind; span: number }[] }
export type RoomListPosition = NonNullable<NonNullable<Layout['chat']>['roomList']>

export type LayoutConfig = {
  nav: Nav
  contentWidth: NonNullable<Layout['contentWidth']>
  /** Order, labels and hidden destinations; null = Score's own menu. */
  menu: NonNullable<Layout['menu']> | null
  /** The Now cards in a grid; null = Score's own arrangement (the cards in the order and widths of today). */
  now: NowArrangement | null
  chat: { messages: 'plain' | 'bubbles'; roomList: RoomListPosition }
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  nav: 'top',
  contentWidth: 'wide',
  menu: null,
  now: null,
  chat: { messages: 'plain', roomList: 'left' },
}

/**
 * Today's Now as a grid, for a theme (or the Customizer) to start from. Score itself renders it with its own flowing
 * markup, which this approximates: the timeline across, the room beside the other cards.
 */
export const DEFAULT_NOW_ARRANGEMENT: NowArrangement = {
  columns: 3,
  cards: [
    { card: 'timeline', span: 3 },
    { card: 'room', span: 2 },
    { card: 'needs-you', span: 1 },
    { card: 'todo', span: 1 },
    { card: 'made-today', span: 1 },
    { card: 'composer', span: 3 },
  ],
}

/** `views.user` laid over the theme, section by section (colours per mode, shape and layout keys one by one). */
export function lookForView(manifest: Look, view: LookView): Look {
  const override = view === 'user' ? (manifest as ThemeManifest).views?.user : undefined
  if (!override) return manifest
  const merged: Look = { ...manifest }
  if (override.colors)
    merged.colors = {
      light: { ...manifest.colors?.light, ...override.colors.light },
      dark: { ...manifest.colors?.dark, ...override.colors.dark },
    }
  if (override.fonts) merged.fonts = { ...manifest.fonts, ...override.fonts }
  if (override.shape) merged.shape = { ...manifest.shape, ...override.shape }
  if (override.layout) {
    const layout = { ...manifest.layout, ...override.layout }
    if (override.layout.chat) layout.chat = { ...manifest.layout?.chat, ...override.layout.chat }
    merged.layout = layout
  }
  if (override.background) merged.background = override.background
  return merged
}

/** Needs-you can be moved but never left out (it goes first when missing); each card appears once. */
export function resolveNow(now: NonNullable<Layout['now']>): NowArrangement {
  const columns = Math.min(4, Math.max(1, Math.round(now.columns)))
  const seen = new Set<NowCardKind>()
  const cards: NowArrangement['cards'] = []
  for (const entry of now.cards) {
    if (seen.has(entry.card)) continue
    seen.add(entry.card)
    cards.push({ card: entry.card, span: Math.min(columns, Math.max(1, Math.round(entry.span))) })
  }
  if (!seen.has('needs-you')) cards.unshift({ card: 'needs-you', span: 1 })
  return { columns, cards }
}

export function resolveLayout(look: Look): LayoutConfig {
  const layout = look.layout
  if (!layout) return DEFAULT_LAYOUT
  return {
    nav: layout.nav ?? DEFAULT_LAYOUT.nav,
    contentWidth: layout.contentWidth ?? DEFAULT_LAYOUT.contentWidth,
    menu: layout.menu ?? null,
    now: layout.now ? resolveNow(layout.now) : null,
    chat: {
      messages: layout.chat?.messages ?? DEFAULT_LAYOUT.chat.messages,
      roomList: layout.chat?.roomList ?? DEFAULT_LAYOUT.chat.roomList,
    },
  }
}

export type MenuItem = { path: string; title: string }

/**
 * The destinations as the menu shows them: the theme's order and labels, the ones it left out hidden. Settings is
 * never hidden: it is added last when the theme forgot it (a broken theme must not lock the owner out).
 */
export function resolveMenu(menu: LayoutConfig['menu']): MenuItem[] {
  if (!menu) return destinations.map(({ path, title }) => ({ path, title }))
  const items: MenuItem[] = []
  for (const entry of menu) {
    if (items.some((item) => item.path === entry.to)) continue
    const known = destinations.find((destination) => destination.path === entry.to)
    if (known) items.push({ path: known.path, title: entry.label ?? known.title })
  }
  if (!items.some((item) => item.path === '/settings'))
    items.push({ path: '/settings', title: 'Settings' })
  return items
}

/** The user view is `/u` and everything below it. */
export function viewOfPath(pathname: string): LookView {
  return pathname === '/u' || pathname.startsWith('/u/') ? 'user' : 'admin'
}

// ---------------------------------------------------------------------------------------------------------------
// The published config.

let current: LayoutConfig = DEFAULT_LAYOUT
const listeners = new Set<() => void>()

export function setLayout(next: LayoutConfig): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  listeners.forEach((listener) => listener())
}

export function getLayout(): LayoutConfig {
  return current
}

/** The layout of the look that is applied now (Score's default when no custom theme is). */
export function useLayout(): LayoutConfig {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getLayout,
    () => DEFAULT_LAYOUT,
  )
}

export function useMenu(): MenuItem[] {
  const { menu } = useLayout()
  return resolveMenu(menu)
}

const CacheLayoutSchema = ThemeManifestSchema.shape.layout

/**
 * The layout the boot cache holds (public/boot-look.js has no access to it, so the runtime reads it before first
 * render): checked against the contract, since localStorage is not trusted.
 */
export function layoutFromCache(value: unknown): LayoutConfig {
  const parsed = CacheLayoutSchema.safeParse(value)
  return parsed.success ? resolveLayout({ layout: parsed.data }) : DEFAULT_LAYOUT
}
