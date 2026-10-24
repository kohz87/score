import { describe, expect, it } from 'vitest'
import {
  addFace,
  afterSave,
  canRedo,
  canUndo,
  clearBackground,
  discard,
  edit,
  emptyManifest,
  freshId,
  hideMenuRow,
  isDirty,
  manifestProblems,
  markSaved,
  menuRows,
  moveMenuRow,
  redo,
  referencedAssets,
  removeFace,
  renameMenuRow,
  setBackgroundDim,
  setBackgroundImage,
  setChat,
  setColor,
  setCss,
  setDetails,
  setShape,
  startHistory,
  undo,
  type Draft,
} from './draft.ts'

const blank = (): Draft => ({ manifest: emptyManifest('mine', 'Mine'), css: '', uploads: {} })

describe('draft edits', () => {
  it('writes only what changed and prunes what empties', () => {
    let d = setColor(blank(), 'light', 'ground', '#112233')
    expect(d.manifest.colors).toEqual({ light: { ground: '#112233' } })
    d = setColor(d, 'light', 'ground', undefined)
    expect(d.manifest.colors).toBeUndefined()
    d = setShape(d, 'radius', 12)
    d = setShape(d, 'radius', undefined)
    expect(d.manifest.shape).toBeUndefined()
    d = setChat(d, 'messages', 'bubbles')
    expect(d.manifest.layout).toEqual({ chat: { messages: 'bubbles' } })
  })

  it('does not change the draft it was given', () => {
    const first = blank()
    const next = setColor(first, 'dark', 'card', '#000000')
    expect(first.manifest.colors).toBeUndefined()
    expect(next).not.toBe(first)
  })

  it('keeps a valid manifest', () => {
    let d = setColor(blank(), 'light', 'ink', '#101010')
    d = setShape(d, 'radius', 'round')
    d = moveMenuRow(d, 0, 2)
    expect(manifestProblems(d.manifest)).toEqual([])
    expect(manifestProblems({ ...d.manifest, name: '' })).toEqual([
      'Give the theme a name (1–60 characters).',
    ])
  })
})

describe('menu', () => {
  it('lists Score’s menu until it is changed', () => {
    expect(menuRows(blank().manifest).map((r) => r.to)).toEqual([
      '/chat',
      '/team',
      '/knowledge',
      '/reports',
      '/settings',
    ])
    expect(blank().manifest.layout).toBeUndefined()
  })

  it('moves, renames and hides entries; Settings stays', () => {
    let d = moveMenuRow(blank(), 1, 0)
    expect(d.manifest.layout?.menu?.[0]).toEqual({ to: '/team' })
    d = renameMenuRow(d, '/team', 'Talk')
    expect(d.manifest.layout?.menu?.[0]).toEqual({ to: '/team', label: 'Talk' })
    d = hideMenuRow(d, '/reports', true)
    expect(d.manifest.layout?.menu?.some((m) => m.to === '/reports')).toBe(false)
    expect(menuRows(d.manifest).at(-1)).toEqual({ to: '/reports', hidden: true })
    expect(hideMenuRow(d, '/settings', true)).toBe(d)
    d = hideMenuRow(d, '/reports', false)
    expect(menuRows(d.manifest).some((r) => r.hidden)).toBe(false)
  })

  it('stores nothing when the menu is Score’s own again', () => {
    let d = moveMenuRow(blank(), 0, 1)
    d = moveMenuRow(d, 1, 0)
    expect(d.manifest.layout).toBeUndefined()
    d = renameMenuRow(renameMenuRow(blank(), '/chat', 'Home'), '/chat', 'Chat')
    expect(d.manifest.layout).toBeUndefined()
  })
})

describe('files', () => {
  it('tracks the files a draft points at', () => {
    const bytes = Uint8Array.from([1])
    let d = addFace(
      blank(),
      { family: 'Brand', src: 'asset:fonts/brand.woff2', weight: '400', style: 'normal' },
      bytes,
    )
    d = setBackgroundImage(d, 'asset:img/background.png', bytes)
    d = setCss(d, '.x { background: url(asset:img/extra.png) }')
    expect(referencedAssets(d)).toEqual([
      'fonts/brand.woff2',
      'img/background.png',
      'img/extra.png',
    ])
    expect(Object.keys(d.uploads).sort()).toEqual(['fonts/brand.woff2', 'img/background.png'])
    // CSS-aware (third gate finding 6): a comment is no reference, an escaped spelling is.
    expect(
      referencedAssets(
        setCss(blank(), '/* asset:img/note.png */ .x { background: url(asset\\3a img/real.png) }'),
      ),
    ).toEqual(['img/real.png'])
    d = setBackgroundDim(d, 200)
    expect(d.manifest.background?.dim).toBe(80)
    d = clearBackground(d)
    expect(d.manifest.background).toBeUndefined()
    expect(Object.keys(d.uploads)).toEqual(['fonts/brand.woff2'])
    d = removeFace(d, 'asset:fonts/brand.woff2')
    expect(d.manifest.fonts).toBeUndefined()
    expect(d.uploads).toEqual({})
  })

  it('a role using a removed font goes back to Score’s', () => {
    let d = addFace(
      blank(),
      { family: 'Brand', src: 'asset:fonts/b.woff2', weight: '400', style: 'normal' },
      new Uint8Array(1),
    )
    d = { ...d, manifest: { ...d.manifest, fonts: { ...d.manifest.fonts, heading: 'Brand' } } }
    d = removeFace(d, 'asset:fonts/b.woff2')
    expect(d.manifest.fonts).toBeUndefined()
  })
})

describe('ids', () => {
  it('makes a free address from a name', () => {
    expect(freshId('My Theme!', [])).toBe('my-theme')
    expect(freshId('My Theme', ['my-theme'])).toBe('my-theme-2')
    expect(freshId('Paper', [])).toBe('paper-2')
    expect(freshId('???', [])).toBe('my-theme')
  })
})

describe('history', () => {
  it('undoes, redoes and discards', () => {
    let h = startHistory(blank())
    expect(isDirty(h)).toBe(false)
    h = edit(h, setColor(h.present, 'light', 'ground', '#111111'))
    h = edit(h, setColor(h.present, 'light', 'card', '#222222'))
    expect(isDirty(h)).toBe(true)
    expect(canUndo(h)).toBe(true)
    h = undo(h)
    expect(h.present.manifest.colors?.light).toEqual({ ground: '#111111' })
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(h.present.manifest.colors?.light).toEqual({ ground: '#111111', card: '#222222' })
    h = discard(h)
    expect(isDirty(h)).toBe(false)
    h = undo(h)
    expect(h.present.manifest.colors?.light?.card).toBe('#222222')
  })

  it('folds a dragged colour into one step, and a new edit clears redo', () => {
    let h = startHistory(blank())
    for (let i = 0; i < 5; i++)
      h = edit(h, setColor(h.present, 'light', 'ground', `#00000${i}`), {
        key: 'c:ground',
        now: 1000 + i * 50,
      })
    expect(h.past).toHaveLength(1)
    h = edit(h, setColor(h.present, 'light', 'ground', '#555555'), { key: 'c:ground', now: 9000 })
    expect(h.past).toHaveLength(2)
    h = undo(h)
    h = edit(h, setShape(h.present, 'border', 'strong'))
    expect(canRedo(h)).toBe(false)
  })

  it('Save moves the baseline and keeps undo', () => {
    let h = startHistory(blank())
    h = edit(h, setShape(h.present, 'border', 'strong'))
    h = markSaved(h)
    expect(isDirty(h)).toBe(false)
    expect(canUndo(h)).toBe(true)
    h = undo(h)
    expect(isDirty(h)).toBe(true)
  })

  it('ignores an edit that changes nothing', () => {
    const h = startHistory(blank())
    expect(edit(h, setColor(h.present, 'light', 'ground', undefined))).toBe(h)
  })
})

describe('uploads and saving', () => {
  it('a file replaced at the same path is a change', () => {
    const a = setBackgroundImage(blank(), 'asset:img/background.png', Uint8Array.from([1, 2, 3]))
    let h = startHistory(a)
    expect(isDirty(h)).toBe(false)
    const b = setBackgroundImage(h.present, 'asset:img/background.png', Uint8Array.from([1, 2, 4]))
    h = edit(h, b)
    expect(isDirty(h)).toBe(true)
    // The same bytes in a new array are not.
    h = edit(
      h,
      setBackgroundImage(h.present, 'asset:img/background.png', Uint8Array.from([1, 2, 3])),
    )
    expect(isDirty(h)).toBe(false)
  })

  it('edits made while a save was out stay, and stay unsaved', () => {
    let h = startHistory(blank())
    h = edit(h, setColor(h.present, 'light', 'ground', '#111111'))
    const submitted = h.present
    // The person keeps typing while the request is in flight.
    h = edit(h, setColor(h.present, 'light', 'card', '#222222'))
    h = afterSave(h, submitted, submitted.manifest)
    expect(h.present.manifest.colors?.light).toEqual({ ground: '#111111', card: '#222222' })
    expect(h.baseline.manifest.colors?.light).toEqual({ ground: '#111111' })
    expect(isDirty(h)).toBe(true)
    // With nothing typed meanwhile the draft is simply saved.
    const clean = afterSave(startHistory(blank()), blank(), blank().manifest)
    expect(isDirty(clean)).toBe(false)
  })

  it('a new address is followed even when the draft changed meanwhile', () => {
    let h = startHistory(blank())
    const submitted: Draft = {
      ...h.present,
      manifest: { ...h.present.manifest, id: 'copy', name: 'Copy' },
    }
    h = edit(h, setShape(h.present, 'border', 'strong'))
    h = afterSave(h, submitted, submitted.manifest)
    expect(h.present.manifest.id).toBe('copy')
    expect(h.present.manifest.shape).toEqual({ border: 'strong' })
    expect(isDirty(h)).toBe(true)
  })

  // X10: Save as new renames the draft; nothing else was typed, so the screen follows and is not dirty.
  it('Save as new adopts the new name and address and leaves nothing unsaved', () => {
    const before: Draft = {
      ...blank(),
      manifest: { ...blank().manifest, id: 'old', name: 'Old' },
    }
    const h = startHistory(before)
    const submitted: Draft = { ...before, manifest: { ...before.manifest, id: 'new', name: 'New' } }
    const saved = afterSave(h, submitted, submitted.manifest, before)
    expect(saved.present.manifest).toMatchObject({ id: 'new', name: 'New' })
    expect(isDirty(saved)).toBe(false)
  })

  it('Save as new keeps a name typed while the request was out, and stays unsaved', () => {
    const before: Draft = {
      ...blank(),
      manifest: { ...blank().manifest, id: 'old', name: 'Old' },
    }
    let h = startHistory(before)
    const submitted: Draft = { ...before, manifest: { ...before.manifest, id: 'new', name: 'New' } }
    h = edit(h, setDetails(h.present, { name: 'Typed meanwhile' }))
    h = afterSave(h, submitted, submitted.manifest, before)
    expect(h.present.manifest).toMatchObject({ id: 'new', name: 'Typed meanwhile' })
    expect(isDirty(h)).toBe(true)
  })

  it('Save as new adopts the new name when only another field was typed meanwhile', () => {
    const before: Draft = {
      ...blank(),
      manifest: { ...blank().manifest, id: 'old', name: 'Old' },
    }
    let h = startHistory(before)
    const submitted: Draft = { ...before, manifest: { ...before.manifest, id: 'new', name: 'New' } }
    h = edit(h, setShape(h.present, 'border', 'strong'))
    h = afterSave(h, submitted, submitted.manifest, before)
    expect(h.present.manifest).toMatchObject({ id: 'new', name: 'New' })
    expect(h.present.manifest.shape).toEqual({ border: 'strong' })
    expect(isDirty(h)).toBe(true)
  })
})
