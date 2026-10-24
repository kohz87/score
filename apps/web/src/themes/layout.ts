import { ThemeManifestSchema, hasVisibleCharacter, type ThemeManifest } from '@score/contract'
import { createContext, useContext, useSyncExternalStore } from 'react'
import { destinations } from '../shell/destinations.ts'

// The layout model (PLAN 9.3, design docs/briefs/9-themes.md §7): what a theme's `layout` asks of the components that
// can't be done with an attribute and CSS alone (menu order and labels, the chat options). It is
// resolved here, once, into a plain config with the defaults filled in and the protected parts enforced (Settings
// and Needs-you can't be left out). The engine publishes it after a theme was applied; components read it with
// useLayout(). Until then, and in safe mode or after a skipped theme, every component sees the Score default.

export type Look = Pick<ThemeManifest, 'colors' | 'fonts' | 'shape' | 'layout' | 'background'>
export type LookView = 'admin' | 'user'
type Layout = NonNullable<ThemeManifest['layout']>

export type Nav = NonNullable<Layout['nav']>
export type RoomListPosition = NonNullable<NonNullable<Layout['chat']>['roomList']>

export type LayoutConfig = {
  nav: Nav
  contentWidth: NonNullable<Layout['contentWidth']>
  /** Order, labels and hidden destinations; null = Score's own menu. */
  menu: NonNullable<Layout['menu']> | null
  chat: { messages: 'plain' | 'bubbles'; roomList: RoomListPosition }
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  nav: 'top',
  contentWidth: 'wide',
  menu: null,
  chat: { messages: 'plain', roomList: 'left' },
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

export function resolveLayout(look: Look): LayoutConfig {
  const layout = look.layout
  if (!layout) return DEFAULT_LAYOUT
  return {
    nav: layout.nav ?? DEFAULT_LAYOUT.nav,
    contentWidth: layout.contentWidth ?? DEFAULT_LAYOUT.contentWidth,
    menu: layout.menu ?? null,
    chat: {
      messages: layout.chat?.messages ?? DEFAULT_LAYOUT.chat.messages,
      roomList: layout.chat?.roomList ?? DEFAULT_LAYOUT.chat.roomList,
    },
  }
}

export type MenuItem = {
  path: string
  title: string
  /** Settings only: the accessible name, which says “Settings” whatever the theme calls it. */
  name?: string
}

/**
 * The destinations as the menu shows them: the theme's order and labels, the ones it left out hidden. Settings is
 * never hidden: it is added last when the theme forgot it (a broken theme must not lock the owner out).
 */
export function resolveMenu(menu: LayoutConfig['menu']): MenuItem[] {
  const items: MenuItem[] = []
  if (!menu) items.push(...destinations.map(({ path, title }) => ({ path, title })))
  for (const entry of menu ?? []) {
    if (items.some((item) => item.path === entry.to)) continue
    const known = destinations.find((destination) => destination.path === entry.to)
    // A label with nothing to see (an old cache, a hand-edited look) would blank the destination: it keeps its own name.
    const label = entry.label !== undefined && hasVisibleCharacter(entry.label) ? entry.label : null
    if (known) items.push({ path: known.path, title: label?.trim() || known.title })
  }
  if (!items.some((item) => item.path === '/settings'))
    items.push({ path: '/settings', title: 'Settings' })
  // Settings is the way back from a theme: its accessible name is Score's own word, with the theme's label after it.
  return items.map((item) =>
    item.path === '/settings'
      ? { ...item, name: item.title === 'Settings' ? 'Settings' : `Settings (${item.title})` }
      : item,
  )
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

/**
 * The Customizer's preview (PLAN 9.4) renders the app in a frame of its own with a draft layout. The draft never goes
 * through setLayout(): it lives in this context, so the page around the preview keeps the look that is applied.
 */
export const LayoutOverride = createContext<LayoutConfig | null>(null)

/** The layout of the look that is applied now (Score's default when no custom theme is). */
export function useLayout(): LayoutConfig {
  const override = useContext(LayoutOverride)
  const applied = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getLayout,
    () => DEFAULT_LAYOUT,
  )
  return override ?? applied
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
