import type { AgentSummary, KnowledgeChanged } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMediaQuery } from '../data/use-media.ts'
import { useExport } from '../routes/knowledge/knowledge-export.ts'
import { folderOf } from '../routes/knowledge/knowledge-paths.ts'
import {
  useKnowledgeActions,
  useKnowledgeInfo,
  useKnowledgeLive,
  useKnowledgeTree,
  useSearch,
} from '../routes/knowledge/knowledge-queries.ts'
import { summaryText, useUploadFlow } from '../routes/knowledge/UploadFlow.tsx'
import { BoldLibraryDialogs } from './BoldLibraryDialogs.tsx'
import { BoldLibraryMain } from './BoldLibraryMain.tsx'
import { BoldLibraryNav } from './BoldLibraryNav.tsx'
import { PAGE_DOCUMENTS } from './KnowledgePageParts.tsx'
import {
  COLLAPSED_KEY,
  PAGE_PHONE,
  PHONE,
  filesInDrag,
  folderChain,
  noteGroups,
  readCollapsed,
  type Dialog,
  type ExportRequest,
} from './bold-library-model.ts'
import './bold-library.css'

/** The bold Library: the prototype's two-column side panel, backed by the classic Knowledge hooks and editors. */
export function BoldLibrary({
  agents,
  hidden = false,
  openPath = null,
  page = false,
  onOpened,
  onShare,
}: {
  agents: AgentSummary[]
  hidden?: boolean
  /** 3.19.0: the Knowledge page (folders, list and note in three columns) instead of the side panel. */
  page?: boolean
  /** The page keeps `?note=` in step with the open note (null: none open). */
  onOpened?: (path: string | null) => void
  /** The page's Share to a chat; missing while no chat can take it (the button stays disabled). */
  onShare?: (path: string) => void
  /** A note named by `?note=` (Search); a new path wins even after someone picked another note by hand. */
  openPath?: string | null
}) {
  const phone = useMediaQuery(PHONE)
  const pagePhone = useMediaQuery(PAGE_PHONE)
  // The page's folder rail: '' is every note and file, PAGE_DOCUMENTS the uploaded files, else a folder.
  const [pageFilter, setPageFilter] = useState('')
  // On a phone the notes list folds while a note is open (3.8.1); this unfolds it.
  const [listOpen, setListOpen] = useState(false)
  // The phone page's Back returns focus to the note just left in the list (or the list).
  const [returnedFrom, setReturnedFrom] = useState<string | null | undefined>(undefined)
  const [picks, setPicks] = useState(0)
  // The panel's width picks the layout (rail ≥ 1180, two-column panels ≥ 860): measured, since a CSS container would
  // also contain the editor's fixed dialogs and upload toast.
  const rootRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<'narrow' | 'mid' | 'wide'>('narrow')
  useEffect(() => {
    const element = rootRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.contentRect.width ?? 0
      // The page also holds the folders and the list beside the note, so its right column joins the note a little
      // later (window ~1320, so the note keeps 420px+) than in the side panel.
      const wide = page ? 1320 : 1180
      setWidth(size >= wide ? 'wide' : size >= 860 ? 'mid' : 'narrow')
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [page])
  const info = useKnowledgeInfo()
  const tree = useKnowledgeTree()
  const actions = useKnowledgeActions()
  const mainRef = useRef<HTMLElement>(null)
  const flushRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerFlush = (flush: (() => Promise<boolean>) | null) => {
    flushRef.current = flush
  }
  const [section, setSection] = useState<'notes' | 'files'>('notes')
  // `undefined` means "no explicit choice yet"; null keeps the blank state after the open note is deleted.
  const [selected, setSelected] = useState<string | null | undefined>(undefined)
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  const [filesFolder, setFilesFolder] = useState('')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [dragging, setDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const focusNote = useRef(false)
  const lastOpenedPath = useRef<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  // The folder New note and New folder start in; set by clicking a folder heading. Collapsed folders last the session.
  const [pickedFolder, setPickedFolder] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  function changeCollapsed(change: (next: Set<string>) => void) {
    setCollapsed((current) => {
      const next = new Set(current)
      change(next)
      try {
        sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // Storage can be blocked; the choice then only lasts while the panel is open.
      }
      return next
    })
  }
  function toggleFolder(folder: string) {
    changeCollapsed((next) => {
      if (!next.delete(folder)) next.add(folder)
    })
  }
  // A note opened from Search or a link must not sit inside a folded folder.
  function revealPath(path: string) {
    const chain = folderChain(folderOf(path))
    if (chain.some((folder) => collapsed.has(folder)))
      changeCollapsed((next) => chain.forEach((folder) => next.delete(folder)))
  }
  const [dialogError, setDialogError] = useState<unknown>(null)
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [external, setExternal] = useState<{
    forPath: string | null
    event: KnowledgeChanged
  } | null>(null)
  const search = useSearch(debounced)
  const exporter = useExport(setNotice)
  const flow = useUploadFlow((summary) => {
    const text = summaryText(summary)
    if (text) setNotice(text)
  })
  // A picked folder that was deleted or moved is no longer there: fall back to the top level.
  const picked = tree.data && !tree.data.folders.includes(pickedFolder) ? '' : pickedFolder
  const notes = useMemo(() => tree.data?.notes ?? [], [tree.data])
  const groups = useMemo(() => (tree.data ? noteGroups(tree.data) : []), [tree.data])
  const searching = query.trim() !== ''
  // Like the prototype, a note is already open when the panel has one. An explicit choice wins even while the tree is
  // refetching after a create or move; without one, fall back to the first note (or the empty state).
  const active = useMemo(() => {
    if (selected !== undefined) return selected
    // A phone page starts on the list; the first note opens only on wider screens.
    if (page && pagePhone) return null
    return section === 'notes' ? (tree.data?.notes[0]?.path ?? null) : null
  }, [page, pagePhone, section, selected, tree.data])
  // Folded only once the person chose a note (not the first one shown by default), and not while browsing files.
  const chosen = !page && phone && section === 'notes' && selected != null
  // The phone page shows the list or, once a note is chosen, the note full width with Back.
  // The Files view is a full-width view too (it was hidden on a phone page with no way to see it).
  const reading =
    page && pagePhone && (section === 'files' || (section === 'notes' && selected != null))
  const folded = chosen && !listOpen

  if (openPath && openPath !== openedPath) {
    setOpenedPath(openPath)
    revealPath(openPath)
    setSelected(openPath)
    setSection('notes')
    if (selected !== openPath) setQuery('')
  }
  // Search's `?note=` is removed once consumed: forget it with the parameter, so the same note can be requested again.
  if (!openPath && openedPath !== null) setOpenedPath(null)
  const uploadFolder = section === 'files' ? filesFolder : folderOf(active ?? '')

  useEffect(() => {
    if (openedPath === null) {
      lastOpenedPath.current = null
      return
    }
    if (lastOpenedPath.current === openedPath) return
    lastOpenedPath.current = openedPath
    focusNote.current = phone
  }, [openedPath, phone])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])

  // The same event refreshes every Knowledge query; here it also marks the open note as changed elsewhere.
  useKnowledgeLive((event) => {
    if (event.by !== 'you' && (event.path === active || event.to === active))
      setExternal({ forPath: active, event })
  })

  function open(next: string) {
    setListOpen(false)
    // Picking the note already open still moves focus to it (the list button that had focus folds away).
    setPicks((count) => count + 1)
    revealPath(next)
    setSelected(next)
    setSection('notes')
    setQuery('')
    focusNote.current = phone
    onOpened?.(next)
  }

  useEffect(() => {
    if (!phone || !focusNote.current) return
    let frame = 0
    let tries = 0
    const moveToHeading = () => {
      const main = mainRef.current
      const heading = main?.querySelector<HTMLElement>('.kn-note-head h2, .kn-doc h2')
      if (!heading && tries++ < 40) {
        frame = requestAnimationFrame(moveToHeading)
        return
      }
      if (!heading) return
      focusNote.current = false
      main?.scrollIntoView?.({ block: 'start' })
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
    frame = requestAnimationFrame(moveToHeading)
    return () => cancelAnimationFrame(frame)
  }, [active, phone, section, picks])

  useEffect(() => {
    if (returnedFrom === undefined || reading) return
    const frame = requestAnimationFrame(() => {
      const nav = rootRef.current?.querySelector<HTMLElement>('.bold-library-nav')
      const row = [...(nav?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(
        (item) => item.dataset.path === returnedFrom,
      )
      const target = row ?? nav?.querySelector<HTMLElement>('.bold-knowledge-list')
      if (target) {
        target.tabIndex = row ? 0 : -1
        target.focus()
      }
      setReturnedFrom(undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [returnedFrom, reading, tree.data])

  function openDialog(next: Dialog) {
    setDialogError(null)
    setDialog(next)
  }

  function upload(files: File[], folder: string) {
    setDragging(false)
    setDropTarget(null)
    if (files.length === 0) return
    void flow.start(
      files.map((file) => ({ name: file.name, blob: file })),
      folder,
    )
  }

  return (
    <div
      ref={rootRef}
      className={`sidebody bold-library${page ? ' is-page' : ''}${reading ? ' is-reading' : ''}${dragging ? ' is-dragging' : ''}`}
      data-testid="bold-library"
      data-width={width}
      hidden={hidden}
      onDragOver={(event) => {
        if (!filesInDrag(event)) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragging(false)
        setDropTarget(null)
      }}
      onDrop={(event) => {
        if (!filesInDrag(event)) return
        event.preventDefault()
        setDragging(false)
        setDropTarget(null)
        // A file row in the Files view already handled this drop with its own folder.
        if (event.defaultPrevented) return
        upload([...event.dataTransfer.files], uploadFolder)
      }}
    >
      {dragging && (
        <p className="kn-drop-hint" role="status">
          {(dropTarget ?? uploadFolder) ? (
            <>
              Drop to add the files to <code>{dropTarget ?? uploadFolder}</code>
            </>
          ) : (
            'Drop to add the files to the top level of Knowledge (not into a folder)'
          )}
        </p>
      )}
      <BoldLibraryNav
        active={active}
        agents={agents}
        chosen={chosen}
        collapsed={collapsed}
        debounced={debounced}
        dropTarget={dropTarget}
        flowBusy={flow.busy}
        folded={folded}
        groups={groups}
        onDialog={openDialog}
        onDragging={setDragging}
        onDropTarget={setDropTarget}
        onExportAll={() =>
          setExportRequest({ request: { all: true }, heading: 'Export all of Knowledge' })
        }
        onFiles={() => {
          setSection('files')
          setQuery('')
        }}
        onFilter={(next) => {
          setPageFilter(next)
          setPickedFolder(next === PAGE_DOCUMENTS ? '' : next)
          setSection('notes')
        }}
        onOpen={open}
        onPickedFolder={setPickedFolder}
        onQueryChange={setQuery}
        onToggleFolder={toggleFolder}
        onToggleList={() => setListOpen((value) => !value)}
        onUpload={upload}
        page={page}
        pageFilter={pageFilter}
        picked={picked}
        query={query}
        reading={reading}
        search={search}
        searching={searching}
        section={section}
        tree={tree}
        uploadFolder={uploadFolder}
      />

      <BoldLibraryMain
        actions={actions}
        active={active}
        agents={agents}
        exporter={exporter}
        external={external}
        filesFolder={filesFolder}
        flowBusy={flow.busy}
        info={info}
        mainRef={mainRef}
        notes={notes}
        notice={notice}
        onBack={() => {
          setReturnedFrom(active ?? null)
          setSelected(undefined)
          setSection('notes')
          onOpened?.(null)
        }}
        onDialog={openDialog}
        onDismissExternal={() => setExternal(null)}
        onDismissNotice={() => setNotice(null)}
        onOpen={open}
        onRegisterFlush={registerFlush}
        onSelectFilesFolder={setFilesFolder}
        onShare={onShare}
        onUpload={upload}
        page={page}
        pagePhone={pagePhone}
        reading={reading}
        section={section}
        tree={tree}
      />

      <BoldLibraryDialogs
        actions={actions}
        active={active}
        dialog={dialog}
        dialogError={dialogError}
        exportRequest={exportRequest}
        exporter={exporter}
        flushRef={flushRef}
        info={info}
        onClose={() => setDialog(null)}
        onDialogError={setDialogError}
        onOpen={open}
        onSelect={setSelected}
        onSetCollapsed={setCollapsed}
        onSetExportRequest={setExportRequest}
        onSetFilesFolder={setFilesFolder}
        onSetNotice={setNotice}
        onSetPickedFolder={setPickedFolder}
        onSetSection={setSection}
        tree={tree}
        uploadDialogs={flow.dialogs}
      />
    </div>
  )
}

export { folderChain }
