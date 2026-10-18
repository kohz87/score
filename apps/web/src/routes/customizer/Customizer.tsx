import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'
import {
  themeAssetUrl,
  type ThemeColorToken,
  type ThemeDetail,
  type ThemeSanitiseReport,
} from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { dataUrlFor } from '../../themes/customizer/asset-types.ts'
import {
  CHANGED_ELSEWHERE,
  describeSaveError,
  fetchThemeAsset,
  fetchThemeLicenses,
  installThemeZip,
  loadTheme,
  saveCustomTheme,
  type SaveProblem,
} from '../../themes/customizer/api.ts'
import { colourFindings, pairProblems, type Finding } from '../../themes/customizer/checks.ts'
import { defaultColor } from '../../themes/customizer/defaults.ts'
import {
  afterSave,
  canRedo,
  canUndo,
  discard,
  edit as editHistory,
  emptyManifest,
  freshId,
  isDirty,
  redo,
  referencedAssets,
  startHistory,
  undo,
  type Draft,
  type History,
  type Mode,
} from '../../themes/customizer/draft.ts'
import { createProbe, type Probe } from '../../themes/customizer/frame-document.ts'
import { textFindingWords } from './text-findings.ts'
import type { TextFinding } from '../../themes/customizer/measure.ts'
import {
  buildThemePackage,
  readThemePackage,
  type ThemePackage,
} from '../../themes/customizer/package.ts'
import { buildFromDraft, filesForSave, saveRoute } from '../../themes/customizer/save.ts'
import {
  readSnapshot,
  THEME_CHANGED_TEXT,
  ThemeChangedError,
  type Snapshot,
} from '../../themes/customizer/snapshot.ts'
import { themesKey } from '../../themes/queries.ts'
import { useLook } from '../../themes/use-look.ts'
import { ImportDialog, type ImportCandidate } from './ImportDialog.tsx'
import { Modal, Segmented } from './controls.tsx'
import { PreviewFrame, type PreviewDraft } from './PreviewFrame.tsx'
import {
  previewDevices,
  previewPages,
  type PreviewDevice,
  type PreviewPage,
} from './preview-pages.ts'
import { WayBackPalette } from './WayBackPalette.tsx'
import { SectionBackground } from './SectionBackground.tsx'
import { SectionColours } from './SectionColours.tsx'
import { SectionCss } from './SectionCss.tsx'
import { SectionFonts } from './SectionFonts.tsx'
import { SectionLayout } from './SectionLayout.tsx'
import { SectionNow } from './SectionNow.tsx'
import { SectionChat, SectionShape } from './SectionShape.tsx'
import { SectionTheme } from './SectionTheme.tsx'
import type { SectionContext } from './section-context.ts'
import './customizer.css'

// Settings › Look › Customize (PLAN 9.4, design §8): a full-screen editor for a theme. The draft lives only in this
// component (a History of values); it is painted into the preview frame and nowhere else until it is saved and used.

type Source = 'new' | 'builtin' | 'imported' | 'custom'
type Target = {
  id: string
  exists: boolean
  source: Source
  etag: string | null
  /** Where files that aren't in the draft come from, and which there are. */
  assetSource: string | null
  assets: string[]
  /** The package revision (etag) `assets` and the draft's manifest and CSS were read at; every file is fetched at it. */
  assetRev: string | null
  /** The licence files the source package has; with none, a copy has no licence to read. */
  licenseFiles: string[]
  /** Those files and licences, read once at `assetRev` when the theme was opened or copied (L1); null for a new theme. */
  snapshot: Snapshot | null
}

/**
 * The files of the version a save just wrote are the ones the package carried: the draft goes on with them and nothing
 * is read back (another writer could land in between). A file or licence the package doesn't hold is read from the
 * server at the saved revision; if that fails the snapshot is left out and files are read when needed, as before.
 */
async function snapshotAfterSave(detail: ThemeDetail, pkg: ThemePackage): Promise<Snapshot | null> {
  const complete =
    detail.assets.every((path) => pkg.assets.has(path)) &&
    (detail.licenseFiles.length === 0 || Object.keys(pkg.licenses).length > 0)
  if (complete)
    return {
      assets: Object.fromEntries(detail.assets.map((path) => [path, pkg.assets.get(path)!])),
      licenses: pkg.licenses,
    }
  try {
    return await readSnapshot(
      detail.manifest.id,
      detail.etag,
      detail,
      fetchThemeAsset,
      fetchThemeLicenses,
    )
  } catch {
    return null
  }
}

/**
 * A theme and its files and licences, read at one revision, once, for the draft that is made from it. A theme replaced
 * while its files are being read (409) is read again from the start; a second miss is reported as it is.
 */
async function loadWithSnapshot(id: string): Promise<{ detail: ThemeDetail; snapshot: Snapshot }> {
  for (let attempt = 0; ; attempt++) {
    const detail = await loadTheme(id)
    try {
      return {
        detail,
        snapshot: await readSnapshot(id, detail.etag, detail, fetchThemeAsset, fetchThemeLicenses),
      }
    } catch (error) {
      if (!(error instanceof ThemeChangedError) || attempt > 0) throw error
    }
  }
}

const tabs = [
  { id: 'theme', label: 'Theme' },
  { id: 'colours', label: 'Colours' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'shape', label: 'Shape' },
  { id: 'layout', label: 'Layout' },
  { id: 'now', label: 'Now' },
  { id: 'chat', label: 'Chat' },
  { id: 'background', label: 'Background' },
  { id: 'css', label: 'Custom CSS' },
] as const
type TabId = (typeof tabs)[number]['id']

function systemMode(): Mode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const hasSettings = (m: Draft['manifest']) =>
  !!(m.colors || m.fonts || m.shape || m.layout || m.background || m.views)

export function Customizer() {
  const { themeId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const look = useLook()
  const themes = look.themes
  const [probe, setProbe] = useState<Probe | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [loadProblem, setLoadProblem] = useState('')
  const [tab, setTab] = useState<TabId>('theme')
  const [mode, setMode] = useState<Mode>(() => {
    const choice = look.mode
    return choice === 'system' ? systemMode() : choice
  })
  const [pageId, setPageId] = useState('now')
  const [deviceId, setDeviceId] = useState<PreviewDevice['id']>('desktop')
  const [pane, setPane] = useState<'edit' | 'preview'>('edit')
  const [status, setStatus] = useState('')
  const [problem, setProblem] = useState<SaveProblem | null>(null)
  const [busy, setBusy] = useState<'' | 'save' | 'export' | 'use'>('')
  const [report, setReport] = useState<ThemeSanitiseReport>({ dropped: [] })
  const [text, setText] = useState<Record<string, TextFinding[]>>({})
  const [saveAs, setSaveAs] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null)
  const [askStart, setAskStart] = useState<string | null>(null)
  const skipReload = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const page: PreviewPage = previewPages.find((item) => item.id === pageId)!
  const device = previewDevices.find((item) => item.id === deviceId)!

  // A hidden frame that tells what Score's own values are (to show and to copy), without the page's look leaking in.
  useEffect(() => {
    let alive = true
    let made: Probe | null = null
    void createProbe().then((value) => {
      if (!alive) return value.dispose()
      made = value
      setProbe(value)
    })
    return () => {
      alive = false
      made?.dispose()
    }
  }, [])

  const takenIds = useMemo(() => themes.map((theme) => theme.id), [themes])

  const copyOf = useCallback(
    async (
      id: string,
      loaded?: { detail: ThemeDetail; snapshot: Snapshot },
    ): Promise<{ draft: Draft; target: Target }> => {
      const { detail, snapshot } = loaded ?? (await loadWithSnapshot(id))
      const name = `${detail.manifest.name} copy`.slice(0, 60)
      const nextId = freshId(name, takenIds)
      const manifest = hasSettings(detail.manifest)
        ? { ...structuredClone(detail.manifest), id: nextId, name, version: '1.0.0' }
        : { ...emptyManifest(nextId, name) }
      return {
        draft: { manifest, css: detail.css, uploads: {} },
        target: {
          id: nextId,
          exists: false,
          source: 'new',
          etag: null,
          assetSource: id,
          assets: detail.assets,
          assetRev: detail.etag,
          licenseFiles: detail.licenseFiles,
          snapshot,
        },
      }
    },
    [takenIds],
  )

  // Open the theme named in the address: a custom or installed theme is edited in place, a built-in one is copied.
  useEffect(() => {
    if (!probe) return
    if (skipReload.current === (themeId ?? '')) {
      skipReload.current = null
      return
    }
    let alive = true
    void (async () => {
      try {
        setLoadProblem('')
        if (!themeId) {
          const id = freshId('My theme', takenIds)
          setHistory(
            startHistory({ manifest: emptyManifest(id, 'My theme'), css: '', uploads: {} }),
          )
          setTarget({
            id,
            exists: false,
            source: 'new',
            etag: null,
            assetSource: null,
            assets: [],
            assetRev: null,
            licenseFiles: [],
            snapshot: null,
          })
          return
        }
        const loaded = await loadWithSnapshot(themeId)
        if (!alive) return
        const { detail, snapshot } = loaded
        if (detail.summary.source === 'builtin') {
          const copy = await copyOf(themeId, loaded)
          if (!alive) return
          setHistory(startHistory(copy.draft))
          setTarget(copy.target)
          return
        }
        // `snapshot` holds this version's files, read now: a later conflict can't take them from "Save as new" or "Export".
        setHistory(startHistory({ manifest: detail.manifest, css: detail.css, uploads: {} }))
        setTarget({
          id: themeId,
          exists: true,
          source: detail.summary.source,
          etag: detail.etag,
          assetSource: themeId,
          assets: detail.assets,
          assetRev: detail.etag,
          licenseFiles: detail.licenseFiles,
          snapshot,
        })
      } catch (error) {
        if (!alive) return
        setLoadProblem(
          error instanceof ThemeChangedError
            ? THEME_CHANGED_TEXT
            : error instanceof ApiError && error.status === 404
              ? 'Couldn’t find that theme. It may have been deleted.'
              : 'Couldn’t open the theme. Check the connection and try again.',
        )
      }
    })()
    return () => {
      alive = false
    }
    // takenIds and copyOf follow the theme list: only the address and the probe decide when to open a theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId, probe])

  const draft = history?.present
  const dirty = history ? isDirty(history) : false

  const edit = useCallback((next: Draft, key?: string) => {
    setHistory((current) => (current ? editHistory(current, next, key ? { key } : {}) : current))
    setStatus('')
    setProblem(null)
  }, [])

  // `probe` is a dependency so the cache starts empty for each probe.
  const defaultsCache = useMemo(() => (probe ? new Map<string, string>() : null), [probe])
  const defaults = useCallback(
    (token: ThemeColorToken, m: Mode) => {
      if (!probe || !defaultsCache) return ''
      const key = `${m}:${token}`
      const known = defaultsCache.get(key)
      if (known !== undefined) return known
      const value = defaultColor(probe, token, m)
      defaultsCache.set(key, value)
      return value
    },
    [probe, defaultsCache],
  )

  // Files added in this session are drawn from their bytes; the rest come from the theme they were copied from.
  const uploads = draft?.uploads
  const resolve = useCallback(
    (ref: string) => {
      const path = ref.slice('asset:'.length)
      const bytes = uploads?.[path]
      if (bytes) return dataUrlFor(bytes, path)
      // The version on screen draws its own files, whatever happened to the theme on the server since.
      const held = target?.snapshot?.assets[path]
      if (held) return dataUrlFor(held, path)
      if (target?.assetSource && target.assetRev && target.assets.includes(path))
        return themeAssetUrl(target.assetSource, path, target.assetRev)
      return null
    },
    [uploads, target],
  )

  const deferredCss = useDeferredValue(draft?.css ?? '')
  const previewDraft = useMemo<PreviewDraft | null>(
    () =>
      draft
        ? { manifest: draft.manifest, css: deferredCss, themeId: draft.manifest.id, resolve }
        : null,
    [draft, deferredCss, resolve],
  )

  const problems = useMemo(
    () => (draft && probe ? pairProblems(draft.manifest, defaults) : []),
    [draft, probe, defaults],
  )
  const findings: Finding[] = useMemo(() => {
    if (!draft || !probe) return []
    const list = colourFindings(draft.manifest, defaults)
    for (const item of text[page.id] ?? [])
      list.push({
        id: `text:${page.id}:${item.text}`,
        where: page.label,
        text: textFindingWords(item, page.label),
      })
    return list
  }, [draft, probe, defaults, text, page])

  // Unsaved changes: leaving asks first.
  const blocker = useBlocker(dirty)
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Undo, redo and save from the keyboard (text fields and the code editor keep their own).
  const actions = useRef({ undo: () => {}, redo: () => {}, save: () => {} })
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const element = event.target as HTMLElement | null
      const typing =
        !!element &&
        (element.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ||
          !!element.closest('.cm-editor'))
      if (key === 's') {
        event.preventDefault()
        actions.current.save()
      } else if (typing) return
      else if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) actions.current.redo()
        else actions.current.undo()
      } else if (key === 'y') {
        event.preventDefault()
        actions.current.redo()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // -------------------------------------------------------------------------------------------------------------
  // Save, export, use, import

  const run = async (kind: 'save' | 'export' | 'use', work: () => Promise<void>) => {
    setBusy(kind)
    setProblem(null)
    setStatus('')
    try {
      await work()
    } catch (error) {
      setProblem(describeSaveError(error))
    } finally {
      setBusy('')
    }
  }

  // A theme may carry licence texts whatever its source (a copy of Ledger saved through PUT keeps OFL.txt).
  const licenceReader = fetchThemeLicenses

  /** Saves the draft; returns the id it was saved under, or null (the problem is shown). */
  async function persist(options: { asNew?: boolean; name?: string } = {}): Promise<string | null> {
    if (!draft || !target || !history) return null
    const asNew = !!options.asNew
    let manifest = { ...draft.manifest }
    if (asNew) {
      const name = (options.name ?? manifest.name).trim().slice(0, 60) || 'My theme'
      manifest = { ...manifest, name, id: freshId(name, takenIds) }
    } else if (!target.exists && takenIds.includes(manifest.id)) {
      manifest = { ...manifest, id: freshId(manifest.name, takenIds) }
    }
    // What is being saved. Whatever is typed while the request is out stays on screen, and stays unsaved.
    const submitted: Draft = { ...draft, manifest }
    const built = await buildFromDraft(
      draft,
      manifest,
      {
        id: target.assetSource,
        assets: target.assets,
        rev: target.assetRev,
        licenseFiles: target.licenseFiles,
        snapshot: target.snapshot,
      },
      fetchThemeAsset,
      licenceReader,
    )
    if (!built.ok) {
      // Replacing the theme this draft was opened from: the file read at the old revision is the same conflict the
      // etag check would report (with Save as new offered). A copy stops with the plain sentence instead.
      if (built.changed && target.exists && !asNew) setProblem(CHANGED_ELSEWHERE)
      else setProblem({ kind: 'rejected', text: built.problems.join(' ') })
      return null
    }
    const route = saveRoute({
      asNew,
      exists: target.exists,
      source: target.source,
    })
    const replacing = target.exists && !asNew
    let detail
    try {
      if (route === 'put') {
        // Files the server already holds for this very theme are kept, not sent again.
        const held = replacing && target.assetSource === target.id ? target.assets : []
        detail = await saveCustomTheme(
          manifest,
          built.pkg.css,
          replacing ? target.etag : null,
          filesForSave(built.pkg, held, draft.uploads),
        )
      } else {
        // The server compares the etag with the stored theme's in the same step as the replace (If-Match).
        // The result carries the committed version and its etag, so nothing is read back (another writer could land
        // between the two requests and the editor would adopt an etag for content it never loaded).
        detail = (
          await installThemeZip(buildThemePackage(built.pkg), {
            replace: replacing,
            ifMatch: replacing ? target.etag : null,
          })
        ).detail
      }
    } catch (error) {
      setProblem(describeSaveError(error))
      return null
    }
    setHistory((current) =>
      current ? afterSave(current, submitted, detail.manifest, draft) : current,
    )
    setTarget({
      id: detail.manifest.id,
      exists: true,
      source: detail.summary.source,
      etag: detail.etag,
      assetSource: detail.manifest.id,
      assets: detail.assets,
      assetRev: detail.etag,
      licenseFiles: detail.licenseFiles,
      snapshot: await snapshotAfterSave(detail, built.pkg),
    })
    await queryClient.invalidateQueries({ queryKey: themesKey })
    if (detail.manifest.id !== themeId) {
      skipReload.current = detail.manifest.id
      void navigate(`/settings/look/customize/${detail.manifest.id}`, { replace: true })
    }
    setStatus(`Saved “${detail.manifest.name}”.`)
    return detail.manifest.id
  }

  const save = () => void run('save', async () => void (await persist()))
  const saveNew = (name: string) =>
    void run('save', async () => void (await persist({ asNew: true, name })))
  useEffect(() => {
    actions.current = {
      undo: () => setHistory((h) => (h ? undo(h) : h)),
      redo: () => setHistory((h) => (h ? redo(h) : h)),
      save: () => {
        if ((dirty || !target?.exists) && !busy) save()
      },
    }
  })

  const exportZip = () =>
    void run('export', async () => {
      if (!draft || !target) return
      const built = await buildFromDraft(
        draft,
        draft.manifest,
        {
          id: target.assetSource,
          assets: target.assets,
          rev: target.assetRev,
          licenseFiles: target.licenseFiles,
          snapshot: target.snapshot,
        },
        fetchThemeAsset,
        licenceReader,
      )
      if (!built.ok) {
        setProblem({ kind: 'rejected', text: built.problems.join(' ') })
        return
      }
      download(buildThemePackage(built.pkg), `${draft.manifest.id}.zip`)
      setStatus(`Exported “${draft.manifest.name}” as ${draft.manifest.id}.zip.`)
    })

  const use = (scope: 'device' | 'everyone') =>
    void run('use', async () => {
      if (!draft || !target) return
      let id = target.id
      if (dirty || !target.exists) {
        const saved = await persist()
        if (!saved) return
        id = saved
      }
      if (scope === 'device') {
        look.chooseForDevice(id)
        setStatus('This device now uses the theme.')
      } else {
        await look.saveShared({ activeTheme: id, mode: look.sharedMode })
        look.chooseForDevice(null)
        setStatus('Every device now uses the theme.')
      }
    })

  async function pickFile(file: File | undefined) {
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setCandidate({ ok: false, name: file.name, reasons: ['The file is larger than 5 MB.'] })
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const read = await readThemePackage(bytes)
    // The dialog says whether a theme with this address exists: ask the server, not a list read a while ago.
    await queryClient.invalidateQueries({ queryKey: themesKey })
    setCandidate(
      read.ok
        ? { ok: true, name: file.name, bytes, pkg: read.pkg }
        : { ok: false, name: file.name, reasons: read.reasons },
    )
  }

  async function startFrom(id: string) {
    try {
      const copy = await copyOf(id)
      setHistory(startHistory(copy.draft))
      setTarget(copy.target)
      if (themeId) {
        // The address changes to the new-theme one; the draft is already in place, so the effect must not reload it.
        skipReload.current = ''
        void navigate('/settings/look/customize', { replace: true })
      }
      setStatus(`Started from “${themes.find((theme) => theme.id === id)?.name ?? id}”.`)
    } catch (error) {
      setProblem({
        kind: 'other',
        text:
          error instanceof ThemeChangedError
            ? THEME_CHANGED_TEXT
            : 'Couldn’t open that theme. Try again.',
      })
    }
    setAskStart(null)
  }

  // -------------------------------------------------------------------------------------------------------------

  if (loadProblem)
    return (
      <div className="cz cz-empty">
        <p role="alert">{loadProblem}</p>
        <Link className="cz-btn cz-error-back" to="/settings#look" data-protected="raised">
          Back to Settings
        </Link>
        <WayBackPalette />
      </div>
    )
  if (!history || !draft || !target || !previewDraft)
    return (
      <div className="cz cz-empty">
        <p role="status">Opening the Customizer…</p>
        <WayBackPalette />
      </div>
    )

  const context: SectionContext = {
    draft,
    edit,
    mode,
    setMode,
    defaults,
    problems,
    resolve,
    announce: setStatus,
    report,
  }
  // Saving a theme that is in use changes it where it is used, like publishing: the bar says so.
  const inUseShared = target.exists && look.sharedId === target.id
  const inUseDevice = target.exists && look.deviceId === target.id
  const inUseNote = inUseShared
    ? 'This theme is in use. Saving changes it on every device that uses it.'
    : inUseDevice
      ? 'This theme is in use. Saving changes it on this device.'
      : ''
  const shownFindings = findings
  const filesUsed = referencedAssets(draft).length

  return (
    <div className="cz" data-pane={pane}>
      <header className="cz-bar">
        <Link className="cz-back" to="/settings#look" data-protected="raised">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
          Settings
        </Link>
        <div className="cz-title">
          <h1>Customize</h1>
          <p className="cz-theme-name">
            {draft.manifest.name}
            {dirty && <span className="cz-unsaved"> · Unsaved changes</span>}
            {!dirty && !target.exists && <span className="cz-unsaved"> · Not saved yet</span>}
          </p>
        </div>
        <div className="cz-actions-wrap">
          {inUseNote && (
            <p className="cz-inuse" id="cz-inuse">
              {inUseNote}
            </p>
          )}
          <div className="cz-actions" role="toolbar" aria-label="Theme actions">
            <button
              type="button"
              className="cz-btn"
              disabled={!canUndo(history)}
              onClick={() => setHistory(undo(history))}
            >
              Undo
            </button>
            <button
              type="button"
              className="cz-btn"
              disabled={!canRedo(history)}
              onClick={() => setHistory(redo(history))}
            >
              Redo
            </button>
            <button
              type="button"
              className="cz-btn"
              disabled={!dirty}
              onClick={() => {
                setHistory(discard(history))
                setStatus('Went back to the saved theme. Undo brings your changes back.')
              }}
            >
              Discard
            </button>
            <span className="cz-sep" aria-hidden="true" />
            <button
              type="button"
              className="cz-btn cz-btn--primary"
              disabled={!(dirty || !target.exists) || !!busy}
              aria-describedby={inUseNote ? 'cz-inuse' : undefined}
              onClick={save}
            >
              {busy === 'save' ? 'Saving…' : inUseNote ? 'Save and apply' : 'Save'}
            </button>
            <button
              type="button"
              className="cz-btn"
              disabled={!!busy}
              onClick={() => setSaveAs(`${draft.manifest.name} copy`.slice(0, 60))}
            >
              Save as new…
            </button>
            <span className="cz-sep" aria-hidden="true" />
            <button type="button" className="cz-btn" disabled={!!busy} onClick={exportZip}>
              Export
            </button>
            <button
              type="button"
              className="cz-btn"
              disabled={!!busy}
              onClick={() => fileInput.current?.click()}
            >
              Import…
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              hidden
              aria-label="Theme file to import"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                void pickFile(file)
              }}
            />
          </div>
        </div>
      </header>

      <div className="cz-messages">
        <p className="cz-status" role="status">
          {status}
        </p>
        {problem && (
          <p className="cz-problem" role="alert">
            {problem.text}
            {problem.kind === 'conflict' && (
              <>
                {' '}
                <button
                  type="button"
                  className="cz-link"
                  onClick={() => setSaveAs(`${draft.manifest.name} copy`.slice(0, 60))}
                >
                  Save as new…
                </button>
              </>
            )}
          </p>
        )}
      </div>

      <div className="cz-switch">
        <Segmented
          label="Show"
          value={pane}
          onChange={setPane}
          options={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      </div>

      <div className="cz-body">
        <section className="cz-preview" aria-label="Preview">
          <div className="cz-preview-bar">
            <label>
              <span className="cz-visually-hidden">Page to preview</span>
              <select
                className="score-select cz-select"
                value={pageId}
                onChange={(event) => setPageId(event.target.value)}
              >
                {previewPages.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <Segmented
              label="Preview colours"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
            <Segmented
              label="Preview size"
              value={deviceId}
              onChange={setDeviceId}
              options={previewDevices.map((item) => ({ value: item.id, label: item.label }))}
            />
          </div>
          <PreviewFrame
            draft={previewDraft}
            mode={mode}
            page={page}
            device={device}
            onPainted={(result) => setReport(result.report)}
            onText={(where, list) => setText((current) => ({ ...current, [where.id]: list }))}
          />
          <section className="cz-checks" aria-label="Contrast checks">
            <h2>
              {shownFindings.length === 0
                ? 'No contrast problems found'
                : shownFindings.length === 1
                  ? '1 contrast problem'
                  : `${shownFindings.length} contrast problems`}
            </h2>
            {shownFindings.length === 0 ? (
              <p>Text on this page is readable with these colours.</p>
            ) : (
              <ul>
                {shownFindings.map((finding) => (
                  <li key={finding.id}>
                    <strong>{finding.where}:</strong> {finding.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>

        <section className="cz-controls" aria-label="Edit the theme">
          <Tabs value={tab} onChange={setTab} />
          <div
            className="cz-panel"
            role="tabpanel"
            id={`cz-panel-${tab}`}
            aria-labelledby={`cz-tab-${tab}`}
            tabIndex={-1}
          >
            {tab === 'theme' && (
              <SectionTheme
                {...context}
                themes={themes}
                exists={target.exists}
                source={target.source}
                idFor={(name) => freshId(name, takenIds)}
                startFrom={(id) => (dirty ? setAskStart(id) : void startFrom(id))}
              />
            )}
            {tab === 'colours' && <SectionColours {...context} />}
            {tab === 'fonts' && <SectionFonts {...context} />}
            {tab === 'shape' && <SectionShape {...context} />}
            {tab === 'layout' && <SectionLayout {...context} />}
            {tab === 'now' && <SectionNow {...context} />}
            {tab === 'chat' && <SectionChat {...context} />}
            {tab === 'background' && <SectionBackground {...context} />}
            {tab === 'css' && <SectionCss {...context} />}
          </div>
          <footer className="cz-use">
            <p className="cz-note">
              {dirty || !target.exists
                ? 'Using a theme saves your changes first.'
                : filesUsed > 0
                  ? 'Saved, with its files.'
                  : 'Saved.'}
            </p>
            <div className="cz-use-buttons">
              <button
                type="button"
                className="cz-btn"
                disabled={!!busy}
                onClick={() => use('device')}
              >
                Use on this device
              </button>
              <button
                type="button"
                className="cz-btn cz-btn--primary"
                disabled={!!busy}
                onClick={() => use('everyone')}
              >
                Use for every device
              </button>
            </div>
          </footer>
        </section>
      </div>

      {saveAs !== null && (
        <Modal title="Save as a new theme" onClose={() => setSaveAs(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const name = saveAs.trim()
              if (!name) return
              setSaveAs(null)
              saveNew(name)
            }}
          >
            <label className="cz-modal-field">
              Name
              <input
                type="text"
                className="cz-input"
                maxLength={60}
                value={saveAs}
                onChange={(event) => setSaveAs(event.target.value)}
              />
            </label>
            <p className="cz-note">
              The original stays as it is. The new theme gets its own address:{' '}
              <code>{freshId(saveAs, takenIds)}</code>.
            </p>
            <div className="cz-modal-actions">
              <button type="button" className="cz-btn" onClick={() => setSaveAs(null)}>
                Cancel
              </button>
              <button type="submit" className="cz-btn cz-btn--primary" disabled={!saveAs.trim()}>
                Save as new
              </button>
            </div>
          </form>
        </Modal>
      )}

      {askStart !== null && (
        <Modal title="Start from another theme?" onClose={() => setAskStart(null)}>
          <p>You have unsaved changes. Starting from another theme replaces them.</p>
          <div className="cz-modal-actions">
            <button type="button" className="cz-btn" onClick={() => setAskStart(null)}>
              Keep editing
            </button>
            <button
              type="button"
              className="cz-btn cz-btn--primary"
              onClick={() => void startFrom(askStart)}
            >
              Replace my changes
            </button>
          </div>
        </Modal>
      )}

      {candidate && (
        <ImportDialog
          candidate={candidate}
          themes={themes}
          onClose={() => setCandidate(null)}
          onInstalled={() => void queryClient.invalidateQueries({ queryKey: themesKey })}
          onOpen={(id) => {
            setCandidate(null)
            void navigate(`/settings/look/customize/${id}`)
          }}
        />
      )}

      <WayBackPalette />

      {blocker.state === 'blocked' && (
        <Modal title="Leave without saving?" onClose={() => blocker.reset()}>
          <p>
            “{draft.manifest.name}” has changes that aren’t saved. If you leave now, they’re lost.
          </p>
          <div className="cz-modal-actions">
            <button
              type="button"
              className="cz-btn cz-btn--primary"
              onClick={() => blocker.reset()}
            >
              Keep editing
            </button>
            <button type="button" className="cz-btn" onClick={() => blocker.proceed()}>
              Leave and lose changes
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Tabs({ value, onChange }: { value: TabId; onChange: (id: TabId) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  function onKeyDown(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1
    if (next < 0) return
    event.preventDefault()
    onChange(tabs[next]!.id)
    refs.current[next]?.focus()
  }
  return (
    <div className="cz-tabs" role="tablist" aria-label="Sections">
      {tabs.map((item, index) => (
        <button
          key={item.id}
          ref={(element) => {
            refs.current[index] = element
          }}
          type="button"
          role="tab"
          id={`cz-tab-${item.id}`}
          aria-selected={value === item.id}
          aria-controls={`cz-panel-${item.id}`}
          tabIndex={value === item.id ? 0 : -1}
          className="cz-tab"
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
