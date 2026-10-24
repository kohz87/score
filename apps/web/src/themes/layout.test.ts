import { describe, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import {
  DEFAULT_LAYOUT,
  layoutFromCache,
  lookForView,
  resolveLayout,
  resolveMenu,
} from './layout.ts'
import { applyCustom, clearLook } from './engine.ts'

describe('layout model', () => {
  test('a theme without layout is the Score default', () => {
    expect(resolveLayout({})).toBe(DEFAULT_LAYOUT)
    expect(resolveMenu(null).map((item) => item.path)).toEqual([
      '/chat',
      '/team',
      '/knowledge',
      '/reports',
      '/settings',
    ])
  })

  test('the menu follows the theme and Settings can never be left out', () => {
    expect(resolveMenu([{ to: '/chat', label: 'Talk' }, { to: '/team' }, { to: '/chat' }])).toEqual(
      [
        { path: '/chat', title: 'Talk' },
        { path: '/team', title: 'Team' },
        { path: '/settings', title: 'Settings', name: 'Settings' },
      ],
    )
    expect(resolveMenu([{ to: '/settings', label: 'Setup' }, { to: '/team' }])).toEqual([
      { path: '/settings', title: 'Setup', name: 'Settings (Setup)' },
      { path: '/team', title: 'Team' },
    ])
    expect(resolveMenu([])).toEqual([{ path: '/settings', title: 'Settings', name: 'Settings' }])
  })

  test('a label with nothing to see never reaches the menu (a stale cache, an old manifest): the destination keeps its name', () => {
    expect(
      resolveMenu([
        { to: '/settings', label: ' \u200b ' },
        { to: '/team', label: '\u2060' },
      ]),
    ).toEqual([
      { path: '/settings', title: 'Settings', name: 'Settings' },
      { path: '/team', title: 'Team' },
    ])
  })

  test('Settings keeps a trusted name that holds whatever the theme calls it', () => {
    expect(resolveMenu([{ to: '/settings', label: 'Setup' }])).toEqual([
      { path: '/settings', title: 'Setup', name: 'Settings (Setup)' },
    ])
    expect(resolveMenu(null).find((item) => item.path === '/settings')).toEqual({
      path: '/settings',
      title: 'Settings',
      name: 'Settings',
    })
  })

  test('views.user is laid over the theme key by key, and only in the user view', () => {
    const manifest = {
      colors: { light: { ground: '#fafafa', ink: '#111111' } },
      shape: { radius: 'sharp' as const, border: 'hairline' as const },
      layout: {
        nav: 'left' as const,
        chat: { messages: 'bubbles' as const, roomList: 'right' as const },
      },
      views: {
        user: {
          colors: { light: { ground: '#eeeeee' } },
          shape: { radius: 'round' as const },
          layout: { chat: { roomList: 'hidden-until-opened' as const } },
        },
      },
    }
    expect(lookForView(manifest, 'admin')).toBe(manifest)
    const user = lookForView(manifest, 'user')
    expect(user.colors?.light).toEqual({ ground: '#eeeeee', ink: '#111111' })
    expect(user.shape).toEqual({ radius: 'round', border: 'hairline' })
    expect(resolveLayout(user).chat).toEqual({
      messages: 'bubbles',
      roomList: 'hidden-until-opened',
    })
    expect(resolveLayout(user).nav).toBe('left')
  })

  test('a cached layout is checked before it is believed', () => {
    expect(layoutFromCache({ nav: 'launcher' }).nav).toBe('launcher')
    expect(layoutFromCache({ nav: 'sideways' })).toBe(DEFAULT_LAYOUT)
    expect(layoutFromCache('x')).toBe(DEFAULT_LAYOUT)
    expect(layoutFromCache(undefined)).toBe(DEFAULT_LAYOUT)
  })

  test('a theme saved before 11.11 still loads: layout.now is ignored and /now or /tasks leave the menu', () => {
    const manifest = ThemeManifestSchema.parse({
      format: 1,
      id: 'old',
      name: 'Old',
      layout: {
        nav: 'left',
        menu: [{ to: '/now', label: 'Today' }, { to: '/tasks' }, { to: '/chat', label: 'Talk' }],
        now: {
          columns: 2,
          cards: [
            { card: 'timeline', span: 2 },
            { card: 'needs-you', span: 1 },
          ],
        },
        chat: { messages: 'bubbles' },
      },
    })
    const layout = resolveLayout(manifest)
    expect(layout).not.toHaveProperty('now')
    expect(layout.chat).toEqual({ messages: 'bubbles', roomList: 'left' })
    expect(resolveMenu(layout.menu)).toEqual([
      { path: '/chat', title: 'Talk' },
      { path: '/settings', title: 'Settings', name: 'Settings' },
    ])
  })

  test('the engine applies the view it is asked for and caches both', () => {
    const detail = {
      id: 'duo',
      manifest: {
        layout: { nav: 'right' as const },
        shape: { density: 'airy' as const },
        views: { user: { shape: { density: 'compact' as const } } },
      },
      css: '',
    }
    const root = document.documentElement
    const admin = applyCustom(detail, 'light', 'admin')
    expect(root.getAttribute('data-nav')).toBe('right')
    expect(root.getAttribute('data-layout')).toBe('side')
    expect(root.getAttribute('data-density')).toBe('airy')
    expect(admin.userCache.attributes['data-density']).toBe('compact')
    const user = applyCustom(detail, 'light', 'user')
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(user.cache.attributes['data-density']).toBe('airy')
    clearLook()
    for (const name of ['data-pack', 'data-layout', 'data-density']) root.removeAttribute(name)
  })
})
