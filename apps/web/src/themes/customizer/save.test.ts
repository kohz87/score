import { describe, expect, it } from 'vitest'
import { emptyManifest, setBackgroundImage, setCss, type Draft } from './draft.ts'
import { buildFromDraft, saveRoute } from './save.ts'

const draft = (): Draft => ({ manifest: emptyManifest('mine', 'Mine'), css: '', uploads: {} })
const never = () => Promise.reject(new Error('no fetch expected'))

describe('buildFromDraft', () => {
  it('packs the manifest, the sanitised CSS and only the files it points at', async () => {
    let d = setBackgroundImage(draft(), 'asset:img/background.png', Uint8Array.from([1, 2]))
    d = { ...d, uploads: { ...d.uploads, 'img/unused.png': Uint8Array.from([9]) } }
    const built = await buildFromDraft(d, d.manifest, { id: null, assets: [] }, never)
    expect(built.ok).toBe(true)
    if (built.ok) expect([...built.pkg.assets.keys()]).toEqual(['img/background.png'])
  })

  it('takes files that aren’t in the draft from the theme they came from', async () => {
    const d = setCss(draft(), '.a { background: url(asset:img/old.webp) }')
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'old', assets: ['img/old.webp'] },
      async (id, path) => {
        expect([id, path]).toEqual(['old', 'img/old.webp'])
        return Uint8Array.from([7])
      },
    )
    expect(built.ok && built.pkg.assets.get('img/old.webp')?.[0]).toBe(7)
  })

  it('says what is wrong in plain words', async () => {
    const d = setCss(draft(), '.a { background: url(asset:img/gone.png) }')
    const bad = { ...d.manifest, name: '' }
    const built = await buildFromDraft(d, bad, { id: null, assets: [] }, never)
    expect(built).toEqual({
      ok: false,
      problems: [
        'Give the theme a name (1–60 characters).',
        'The file “img/gone.png” is used but isn’t there. Add it again or remove it.',
      ],
    })
  })
})

describe('licence files', () => {
  it('takes the licences of the theme a draft was copied from', async () => {
    const d = setCss(draft(), '.a { background: url(asset:fonts/f.woff2) }')
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'ledger', assets: ['fonts/f.woff2'] },
      async () => Uint8Array.from([1]),
      async (id) => {
        expect(id).toBe('ledger')
        return { 'OFL.txt': 'Open Font License' }
      },
    )
    expect(built.ok && built.pkg.licenses).toEqual({ 'OFL.txt': 'Open Font License' })
  })
  it('keeps the licences a draft already holds without asking again', async () => {
    const d: Draft = { ...draft(), licenses: { LICENSE: 'MIT' } }
    const built = await buildFromDraft(d, d.manifest, { id: 'x', assets: [] }, never, never)
    expect(built.ok && built.pkg.licenses).toEqual({ LICENSE: 'MIT' })
  })
  it('says so when the licences can’t be read', async () => {
    const built = await buildFromDraft(
      draft(),
      draft().manifest,
      { id: 'x', assets: [] },
      never,
      never,
    )
    expect(built).toEqual({
      ok: false,
      problems: ['Couldn’t read the licence files of the theme this one comes from. Try again.'],
    })
  })
})

describe('saveRoute', () => {
  const base = { asNew: false, exists: true, source: 'custom' as const, hasFiles: false }
  it('uses PUT for a new or custom theme without files', () => {
    expect(saveRoute({ ...base, exists: false, source: 'new' })).toBe('put')
    expect(saveRoute(base)).toBe('put')
    expect(saveRoute({ ...base, asNew: true, source: 'imported' })).toBe('put')
  })
  it('sends a zip when there are files, or the theme was installed from one', () => {
    expect(saveRoute({ ...base, hasFiles: true })).toBe('zip')
    expect(saveRoute({ ...base, source: 'imported' })).toBe('zip')
  })
})
