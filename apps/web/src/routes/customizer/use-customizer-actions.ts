import type { QueryClient } from '@tanstack/react-query'
import type { ThemeSummary } from '@score/contract'
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { NavigateFunction } from 'react-router'
import type { UploadProgress as Progress } from '../../data/api.ts'
import {
  CHANGED_ELSEWHERE,
  describeSaveError,
  fetchThemeAsset,
  fetchThemeLicenses,
  installThemeZip,
  saveCustomTheme,
  type SaveProblem,
} from '../../themes/customizer/api.ts'
import {
  afterSave,
  freshId,
  redo,
  startHistory,
  undo,
  type Draft,
  type History,
} from '../../themes/customizer/draft.ts'
import { buildThemePackage, readThemePackage } from '../../themes/customizer/package.ts'
import { buildFromDraft, filesForSave, saveRoute } from '../../themes/customizer/save.ts'
import { THEME_CHANGED_TEXT, ThemeChangedError } from '../../themes/customizer/snapshot.ts'
import { themesKey } from '../../themes/queries.ts'
import type { Look } from '../../themes/use-look.ts'
import { download } from './customizer-helpers.ts'
import type { Busy, Target } from './customizer-types.ts'
import type { ImportCandidate } from './ImportDialog.tsx'
import { snapshotAfterSave } from './theme-files.ts'
import type { CopyOf } from './use-theme-loader.ts'

type ActionsInput = {
  draft: Draft | null
  target: Target | null
  history: History | null
  dirty: boolean
  takenIds: string[]
  themeId: string | undefined
  themes: ThemeSummary[]
  look: Look
  copyOf: CopyOf
  skipReloadRef: MutableRefObject<string | null>
  setHistory: Dispatch<SetStateAction<History | null>>
  setTarget: Dispatch<SetStateAction<Target | null>>
  navigate: NavigateFunction
  queryClient: QueryClient
}

type ActionsResult = {
  status: string
  setStatus: Dispatch<SetStateAction<string>>
  problem: SaveProblem | null
  setProblem: Dispatch<SetStateAction<SaveProblem | null>>
  busy: Busy
  sent: Progress | null
  saveAs: string | null
  setSaveAs: Dispatch<SetStateAction<string | null>>
  candidate: ImportCandidate | null
  setCandidate: Dispatch<SetStateAction<ImportCandidate | null>>
  askStart: string | null
  setAskStart: Dispatch<SetStateAction<string | null>>
  save: () => void
  saveNew: (name: string) => void
  exportZip: () => void
  use: (scope: 'device' | 'everyone') => void
  pickFile: (file: File | undefined) => Promise<void>
  startFrom: (id: string) => Promise<void>
}

export function useCustomizerActions({
  draft,
  target,
  history,
  dirty,
  takenIds,
  themeId,
  themes,
  look,
  copyOf,
  skipReloadRef,
  setHistory,
  setTarget,
  navigate,
  queryClient,
}: ActionsInput): ActionsResult {
  const [status, setStatus] = useState('')
  const [problem, setProblem] = useState<SaveProblem | null>(null)
  const [busy, setBusy] = useState<Busy>('')
  const [sent, setSent] = useState<Progress | null>(null)
  const [saveAs, setSaveAs] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null)
  const [askStart, setAskStart] = useState<string | null>(null)

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
        const zip = buildThemePackage(built.pkg)
        setSent({ loaded: 0, total: zip.length })
        detail = (
          await installThemeZip(zip, {
            replace: replacing,
            ifMatch: replacing ? target.etag : null,
            onProgress: setSent,
          })
        ).detail
      }
    } catch (error) {
      setProblem(describeSaveError(error))
      return null
    } finally {
      setSent(null)
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
      skipReloadRef.current = detail.manifest.id
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
        skipReloadRef.current = ''
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

  return {
    status,
    setStatus,
    problem,
    setProblem,
    busy,
    sent,
    saveAs,
    setSaveAs,
    candidate,
    setCandidate,
    askStart,
    setAskStart,
    save,
    saveNew,
    exportZip,
    use,
    pickFile,
    startFrom,
  }
}
