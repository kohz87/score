import { describe, expect, test } from 'vitest'
import {
  DEFAULT_LAYOUT,
  layoutFromCache,
  lookForView,
  resolveLayout,
  resolveMenu,
  resolveNow,
  viewOfPath,
} from './layout.ts'
import { applyCustom, clearLook } from './engine.ts'

describe('layout model', () => {
  test('a theme without layout is the Score default', () => {
    expect(resolveLayout({})).toBe(DEFAULT_LAYOUT)
    expect(resolveMenu(null).map((item) => item.path)).toEqual([
      '/now',
      '/chat',
      '/tasks',
      '/team',
      '/knowledge',
      '/reports',
      '/settings',
    ])
  })

  test('the menu follows the theme and Settings can never be left out', () => {
    expect(resolveMenu([{ to: '/chat', label: 'Talk' }, { to: '/now' }, { to: '/chat' }])).toEqual([
      { path: '/chat', title: 'Talk' },
      { path: '/now', title: 'Now' },
      { path: '/settings', title: 'Settings' },
    ])
    expect(resolveMenu([{ to: '/settings', label: 'Setup' }, { to: '/now' }])).toEqual([
      { path: '/settings', title: 'Setup' },
      { path: '/now', title: 'Now' },
    ])
    expect(resolveMenu([])).toEqual([{ path: '/settings', title: 'Settings' }])
  })

  test('Needs-you is always on Now, each card once, spans never wider than the grid', () => {
    expect(
      resolveNow({
        columns: 2,
        cards: [
          { card: 'room', span: 4 },
          { card: 'timeline', span: 1 },
          { card: 'room', span: 1 },
        ],
      }),
    ).toEqual({
      columns: 2,
      cards: [
        { card: 'needs-you', span: 1 },
        { card: 'room', span: 2 },
        { card: 'timeline', span: 1 },
      ],
    })
    const kept = resolveNow({
      columns: 3,
      cards: [
        { card: 'timeline', span: 1 },
        { card: 'needs-you', span: 3 },
      ],
    })
    expect(kept.cards.map((card) => card.card)).toEqual(['timeline', 'needs-you'])
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

  test('/u and below is the user view', () => {
    expect(viewOfPath('/u')).toBe('user')
    expect(viewOfPath('/u/rooms/a')).toBe('user')
    expect(viewOfPath('/now')).toBe('admin')
    expect(viewOfPath('/users')).toBe('admin')
  })

  test('a cached layout is checked before it is believed', () => {
    expect(layoutFromCache({ nav: 'launcher' }).nav).toBe('launcher')
    expect(layoutFromCache({ nav: 'sideways' })).toBe(DEFAULT_LAYOUT)
    expect(layoutFromCache('x')).toBe(DEFAULT_LAYOUT)
    expect(layoutFromCache(undefined)).toBe(DEFAULT_LAYOUT)
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
