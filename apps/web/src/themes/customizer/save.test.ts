import { describe, expect, it } from 'vitest'
import { emptyManifest, setBackgroundImage, setCss, type Draft } from './draft.ts'
import { buildFromDraft, filesForSave, saveRoute } from './save.ts'
import { THEME_CHANGED_TEXT, ThemeChangedError } from './snapshot.ts'

const draft = (): Draft => ({ manifest: emptyManifest('mine', 'Mine'), css: '', uploads: {} })
const never = () => Promise.reject(new Error('no fetch expected'))

describe('buildFromDraft', () => {
  it('packs the manifest, the sanitised CSS and only the files it points at', async () => {
    let d = setBackgroundImage(draft(), 'asset:img/background.png', Uint8Array.from([1, 2]))
    d = { ...d, uploads: { ...d.uploads, 'img/unused.png': Uint8Array.from([9]) } }
    const built = await buildFromDraft(d, d.manifest, { id: null, assets: [], rev: null }, never)
    expect(built.ok).toBe(true)
    if (built.ok) expect([...built.pkg.assets.keys()]).toEqual(['img/background.png'])
  })

  it('takes files that aren’t in the draft from the theme they came from', async () => {
    const d = setCss(draft(), '.a { background: url(asset:img/old.webp) }')
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'old', assets: ['img/old.webp'], rev: 'r1' },
      async (id, path, rev) => {
        expect([id, path, rev]).toEqual(['old', 'img/old.webp', 'r1'])
        return Uint8Array.from([7])
      },
    )
    expect(built.ok && built.pkg.assets.get('img/old.webp')?.[0]).toBe(7)
  })

  it('says what is wrong in plain words', async () => {
    const d = setCss(draft(), '.a { background: url(asset:img/gone.png) }')
    const bad = { ...d.manifest, name: '' }
    const built = await buildFromDraft(d, bad, { id: null, assets: [], rev: null }, never)
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
      { id: 'ledger', assets: ['fonts/f.woff2'], rev: 'r2' },
      async () => Uint8Array.from([1]),
      async (id, rev) => {
        expect([id, rev]).toEqual(['ledger', 'r2'])
        return { 'OFL.txt': 'Open Font License' }
      },
    )
    expect(built.ok && built.pkg.licenses).toEqual({ 'OFL.txt': 'Open Font License' })
  })
  it('keeps the licences a draft already holds without asking again', async () => {
    const d: Draft = { ...draft(), licenses: { LICENSE: 'MIT' } }
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'x', assets: [], rev: 'r3' },
      never,
      never,
    )
    expect(built.ok && built.pkg.licenses).toEqual({ LICENSE: 'MIT' })
  })
  it('says so when the licences can’t be read', async () => {
    const built = await buildFromDraft(
      draft(),
      draft().manifest,
      { id: 'x', assets: [], rev: 'r3' },
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
  const base = { asNew: false, exists: true, source: 'custom' as const }
  it('uses PUT for a new or custom theme, whatever files it has (C4 #2)', () => {
    expect(saveRoute({ ...base, exists: false, source: 'new' })).toBe('put')
    expect(saveRoute(base)).toBe('put')
    expect(saveRoute({ ...base, asNew: true, source: 'imported' })).toBe('put')
  })
  it('sends a zip for a theme that was installed from one (PUT can’t change it)', () => {
    expect(saveRoute({ ...base, source: 'imported' })).toBe('zip')
  })
})

describe('filesForSave', () => {
  const pkg = (assets: Record<string, number[]>, licenses: Record<string, string> = {}) => ({
    manifest: emptyManifest('mine', 'Mine'),
    css: '',
    assets: new Map(Object.entries(assets).map(([path, bytes]) => [path, Uint8Array.from(bytes)])),
    licenses,
  })
  it('sends nothing for a theme that has and needs no files', () => {
    expect(filesForSave(pkg({}), [], {})).toEqual({})
  })
  it('keeps what the server holds and sends what is new or replaced, as base64', () => {
    expect(
      filesForSave(
        pkg({ 'img/a.png': [1], 'img/b.png': [2, 3], 'img/c.png': [255] }),
        ['img/a.png', 'img/b.png'],
        {
          'img/b.png': Uint8Array.from([2, 3]),
        },
      ),
    ).toEqual({ keep: ['img/a.png'], assets: { 'img/b.png': 'AgM=', 'img/c.png': '/w==' } })
  })
  it('drops files the theme no longer uses (keep: [])', () => {
    expect(filesForSave(pkg({}), ['img/a.png'], {})).toEqual({ keep: [], assets: {} })
  })
  it('sends the licence texts it holds, and nothing when it holds none', () => {
    expect(
      filesForSave(pkg({ 'fonts/f.woff2': [1] }, { 'OFL.txt': 'x' }), [], {}).licenses,
    ).toEqual({
      'OFL.txt': 'x',
    })
    expect('licenses' in filesForSave(pkg({ 'img/a.png': [1] }), [], {})).toBe(false)
  })
  it('encodes large files without running out of stack', () => {
    const big = new Uint8Array(3_000_000).fill(7)
    const sent = filesForSave({ ...pkg({}), assets: new Map([['img/big.png', big]]) }, [], {})
    expect(sent.assets?.['img/big.png']?.length).toBe(4_000_000)
  })
})

// J1 (fourth-gate finding 2): a copy pairs the draft's manifest and CSS only with files of the revision it was opened at.
describe('one coherent snapshot', () => {
  // A stand-in for the server: the files of every revision, and which one is current.
  const versions: Record<string, { files: Record<string, number>; licence: string }> = {
    a: { files: { 'img/bg.png': 1, 'img/two.png': 1 }, licence: 'licence A' },
    b: { files: { 'img/bg.png': 2, 'img/two.png': 2 }, licence: 'licence B' },
  }
  const serve = (current: () => string) => ({
    asset: async (_id: string, path: string, rev: string | null) => {
      if (rev !== current()) throw new ThemeChangedError()
      return Uint8Array.from([versions[rev]!.files[path]!])
    },
    licences: async (_id: string, rev: string | null) => {
      if (rev !== current()) throw new ThemeChangedError()
      return { LICENSE: versions[rev]!.licence }
    },
  })
  const css = '.a{background:url(asset:img/bg.png)} .b{background:url(asset:img/two.png)}'

  it('copies A when A is still current', async () => {
    const server = serve(() => 'a')
    const d = setCss(draft(), css)
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'src', assets: ['img/bg.png', 'img/two.png'], rev: 'a' },
      server.asset,
      server.licences,
    )
    expect(built.ok && [...built.pkg.assets.values()].map((b) => b[0])).toEqual([1, 1])
    expect(built.ok && built.pkg.licenses).toEqual({ LICENSE: 'licence A' })
  })

  it('refuses the copy when the theme was replaced after the draft was opened', async () => {
    const server = serve(() => 'b')
    const d = setCss(draft(), css)
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'src', assets: ['img/bg.png', 'img/two.png'], rev: 'a' },
      server.asset,
      server.licences,
    )
    expect(built).toEqual({ ok: false, problems: [THEME_CHANGED_TEXT] })
  })

  it('refuses a copy whose replacement lands between two of its reads', async () => {
    let current = 'a'
    const server = serve(() => current)
    const d = setCss(draft(), css)
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'src', assets: ['img/bg.png', 'img/two.png'], rev: 'a' },
      async (id, path, rev) => {
        const bytes = await server.asset(id, path, rev)
        current = 'b' // another editor replaces the theme after the first file was read
        return bytes
      },
      server.licences,
    )
    expect(built).toEqual({ ok: false, problems: [THEME_CHANGED_TEXT] })
  })

  it('does not read licences from a package that has none, so a changed source still copies', async () => {
    const server = serve(() => 'b')
    const d = setCss(draft(), '.a{color:red}')
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'src', assets: [], rev: 'a', licenseFiles: [] },
      server.asset,
      server.licences,
    )
    expect(built.ok && built.pkg.licenses).toEqual({})
  })

  it('refuses when only the licence read finds the change', async () => {
    let current = 'a'
    const server = serve(() => current)
    const d = setCss(draft(), '.a{color:red}')
    const built = await buildFromDraft(
      d,
      d.manifest,
      { id: 'src', assets: [], rev: 'a' },
      server.asset,
      async (id, rev) => {
        current = 'b'
        return server.licences(id, rev)
      },
    )
    expect(built).toEqual({ ok: false, problems: [THEME_CHANGED_TEXT] })
  })
})
