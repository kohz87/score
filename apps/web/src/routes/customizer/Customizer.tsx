import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AgentsSnapshotSchema,
  themeAssetUrl,
  type ThemeColorToken,
  type ThemeSanitiseReport,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useBlocker, useParams } from 'react-router'
import { Link, useNavigate } from '../../shell/framed-paths.tsx'
import { dataUrlFor } from '../../themes/customizer/asset-types.ts'
import { colourFindings, pairProblems, type Finding } from '../../themes/customizer/checks.ts'
import { defaultColor } from '../../themes/customizer/defaults.ts'
import {
  edit as editHistory,
  isDirty,
  referencedAssets,
  type Draft,
  type Mode,
} from '../../themes/customizer/draft.ts'
import { createProbe, type Probe } from '../../themes/customizer/frame-document.ts'
import type { TextFinding } from '../../themes/customizer/measure.ts'
import { useLook } from '../../themes/use-look.ts'
import { CustomizerBar } from './CustomizerBar.tsx'
import { CustomizerModals } from './CustomizerModals.tsx'
import { CustomizerPanel } from './CustomizerPanel.tsx'
import { CustomizerPreview } from './CustomizerPreview.tsx'
import type { TabId } from './CustomizerTabs.tsx'
import { systemMode } from './customizer-helpers.ts'
import type { PreviewDraft } from './PreviewFrame.tsx'
import {
  previewDevices,
  previewAgentId,
  previewPages,
  type PreviewDevice,
  type PreviewPage,
} from './preview-pages.ts'
import type { SectionContext } from './section-context.ts'
import { textFindingWords } from './text-findings.ts'
import { useCustomizerActions } from './use-customizer-actions.ts'
import { useThemeLoader } from './use-theme-loader.ts'
import './customizer.css'

// Settings › Look › Customizer (PLAN 9.4, design §8; moved into Settings by decision 131 E): an editor for a theme. The draft lives only in this
// component (a History of values); it is painted into the preview frame and nowhere else until it is saved and used.

export function Customizer() {
  const { themeId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const look = useLook()
  const themes = look.themes
  const [probe, setProbe] = useState<Probe | null>(null)
  const [tab, setTab] = useState<TabId>('theme')
  const [mode, setMode] = useState<Mode>(() => {
    const choice = look.mode
    return choice === 'system' ? systemMode() : choice
  })
  const [pageId, setPageId] = useState('b-room')
  const [deviceId, setDeviceId] = useState<PreviewDevice['id']>('desktop')
  const [pane, setPane] = useState<'edit' | 'preview'>('edit')
  const [report, setReport] = useState<ThemeSanitiseReport>({ dropped: [] })
  const [text, setText] = useState<Record<string, TextFinding[]>>({})
  // The agent page of the new look needs a real agent: the first of the team (the same read the shell makes).
  const team = useQuery({
    queryKey: ['customizer', 'preview-agents'],
    queryFn: async ({ signal }) =>
      AgentsSnapshotSchema.parse(await apiFetch('agents', { signal })).items,
    enabled: pageId === 'b-agent' || pageId === 'b-screen',
    staleTime: 60_000,
  })
  const page: PreviewPage = previewAgentId(
    previewPages.find((item) => item.id === pageId)!,
    team.data?.[0]?.id ?? null,
  )
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

  const { history, setHistory, target, setTarget, loadProblem, skipReloadRef, copyOf, takenIds } =
    useThemeLoader({ probe, themeId, themes })

  const draft = history?.present
  const dirty = history ? isDirty(history) : false

  const {
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
  } = useCustomizerActions({
    draft: draft ?? null,
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
  })

  const edit = useCallback(
    (next: Draft, key?: string) => {
      setHistory((current) => (current ? editHistory(current, next, key ? { key } : {}) : current))
      setStatus('')
      setProblem(null)
    },
    [setHistory, setStatus, setProblem],
  )

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

  if (loadProblem)
    return (
      <div className="cz cz-empty">
        <p role="alert">{loadProblem}</p>
        <Link className="cz-btn cz-error-back" to="/settings/look" data-protected="raised">
          Back to Settings
        </Link>
      </div>
    )
  if (!history || !draft || !target || !previewDraft)
    return (
      <div className="cz cz-empty">
        <p role="status">Opening the Customizer…</p>
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
      <CustomizerBar
        draft={draft}
        history={history}
        dirty={dirty}
        target={target}
        busy={busy}
        inUseNote={inUseNote}
        status={status}
        sent={sent}
        problem={problem}
        pane={pane}
        setPane={setPane}
        setHistory={setHistory}
        setStatus={setStatus}
        setSaveAs={setSaveAs}
        save={save}
        exportZip={exportZip}
        pickFile={pickFile}
      />

      <div className="cz-body">
        <CustomizerPreview
          target={target}
          dirty={dirty}
          busy={busy}
          mode={mode}
          setMode={setMode}
          pageId={pageId}
          setPageId={setPageId}
          deviceId={deviceId}
          setDeviceId={setDeviceId}
          page={page}
          device={device}
          previewDraft={previewDraft}
          onPainted={(result) => setReport(result.report)}
          onText={(where, list) => setText((current) => ({ ...current, [where.id]: list }))}
          shownFindings={shownFindings}
          filesUsed={filesUsed}
          onUse={use}
        />

        <CustomizerPanel
          tab={tab}
          setTab={setTab}
          context={context}
          themes={themes}
          target={target}
          takenIds={takenIds}
          dirty={dirty}
          setAskStart={setAskStart}
          startFrom={startFrom}
        />
      </div>

      <CustomizerModals
        saveAs={saveAs}
        setSaveAs={setSaveAs}
        saveNew={saveNew}
        takenIds={takenIds}
        askStart={askStart}
        setAskStart={setAskStart}
        startFrom={startFrom}
        candidate={candidate}
        setCandidate={setCandidate}
        themes={themes}
        queryClient={queryClient}
        navigate={navigate}
        draft={draft}
        blocker={blocker}
      />
    </div>
  )
}
