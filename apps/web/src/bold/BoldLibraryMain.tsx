import type { AgentSummary, KnowledgeChanged, KnowledgeNoteSummary } from '@score/contract'
import type { RefObject } from 'react'
import { DocumentWorkspace } from '../routes/knowledge/DocumentWorkspace.tsx'
import { FilesView } from '../routes/knowledge/FilesView.tsx'
import { NoteWorkspace } from '../routes/knowledge/NoteWorkspace.tsx'
import { isNotePath } from '../routes/knowledge/knowledge-files.ts'
import type { useExport } from '../routes/knowledge/knowledge-export.ts'
import { pathForLinkTarget } from '../routes/knowledge/knowledge-paths.ts'
import type {
  useKnowledgeActions,
  useKnowledgeInfo,
  useKnowledgeTree,
} from '../routes/knowledge/knowledge-queries.ts'
import { BookIcon } from './BoldIcons.tsx'
import { SelectedByline } from './BoldLibraryByline.tsx'
import type { Dialog } from './bold-library-model.ts'

export function BoldLibraryMain({
  active,
  actions,
  agents,
  exporter,
  external,
  filesFolder,
  flowBusy,
  info,
  mainRef,
  notes,
  notice,
  onBack,
  onDialog,
  onDismissExternal,
  onDismissNotice,
  onOpen,
  onRegisterFlush,
  onSelectFilesFolder,
  onShare,
  onUpload,
  page,
  pagePhone,
  reading,
  section,
  tree,
}: {
  active: string | null
  actions: ReturnType<typeof useKnowledgeActions>
  agents: AgentSummary[]
  exporter: ReturnType<typeof useExport>
  external: { forPath: string | null; event: KnowledgeChanged } | null
  filesFolder: string
  flowBusy: boolean
  info: ReturnType<typeof useKnowledgeInfo>
  mainRef: RefObject<HTMLElement | null>
  notes: KnowledgeNoteSummary[]
  notice: string | null
  onBack: () => void
  onDialog: (dialog: Dialog) => void
  onDismissExternal: () => void
  onDismissNotice: () => void
  onOpen: (path: string) => void
  onRegisterFlush: (flush: (() => Promise<boolean>) | null) => void
  onSelectFilesFolder: (folder: string) => void
  onShare?: (path: string) => void
  onUpload: (files: File[], folder: string) => void
  page: boolean
  pagePhone: boolean
  reading: boolean
  section: 'notes' | 'files'
  tree: ReturnType<typeof useKnowledgeTree>
}) {
  return (
    <section
      className="kn-main bold-library-main"
      aria-label="Library note"
      ref={mainRef}
      hidden={page && pagePhone && !reading}
    >
      {reading && <h1 className="kn-sr">Knowledge</h1>}
      {reading && (
        <button type="button" className="bold-knowledge-back" onClick={onBack}>
          ← Back to the notes
        </button>
      )}
      {notice && (
        <p className="kn-banner" role="status">
          {notice}{' '}
          <button type="button" onClick={onDismissNotice}>
            Dismiss
          </button>
        </p>
      )}
      {info.data?.moveIssue && (
        <p className="kn-banner is-warn" role="status">
          {info.data.moveIssue.state === 'pending'
            ? `Move pending: ${info.data.moveIssue.from} to ${info.data.moveIssue.to}. Score is finishing it.`
            : `Move needs attention: ${info.data.moveIssue.message}`}{' '}
          {info.data.moveIssue.state === 'conflicted' && (
            <button type="button" onClick={() => actions.dismissMoveIssue.mutate()}>
              Dismiss
            </button>
          )}
        </p>
      )}
      {info.data && !info.data.gitAvailable && (
        <p className="kn-banner is-warn">
          Git isn’t available for Knowledge. Notes still save; history and undo are unavailable.
        </p>
      )}

      {section === 'files' && tree.data ? (
        <FilesView
          tree={tree.data}
          folder={filesFolder}
          agents={agents}
          onOpenPath={onOpen}
          busy={flowBusy}
          onOpenFolder={onSelectFilesFolder}
          onUpload={onUpload}
          onNewFolder={(parent) => onDialog({ kind: 'folder', parent })}
          onMove={(path) => onDialog({ kind: 'move', path })}
          onDelete={(path) => onDialog({ kind: 'delete', path })}
          exporting={exporter.busy}
          onExport={(request) => void exporter.run(request)}
          onDeleteFolder={(folder) => onDialog({ kind: 'folder-delete', path: folder })}
          onRenameFolder={(folder) => onDialog({ kind: 'folder-move', path: folder })}
        />
      ) : active ? (
        <>
          {page && (
            <div className="bold-knowledge-actions">
              <button
                type="button"
                className="bold-knowledge-share"
                disabled={!onShare}
                onClick={() => onShare?.(active)}
              >
                Share to a chat
              </button>
              {isNotePath(active) && (
                <button
                  type="button"
                  className="bold-knowledge-edit"
                  onClick={() =>
                    mainRef.current
                      ?.querySelector<HTMLElement>('[contenteditable="true"], textarea')
                      ?.focus()
                  }
                >
                  Edit
                </button>
              )}
            </div>
          )}
          <SelectedByline path={active} agents={agents} />
          {isNotePath(active) ? (
            <NoteWorkspace
              key={active}
              path={active}
              notes={notes}
              agents={agents}
              onOpenPath={onOpen}
              external={external?.forPath === active ? external.event : null}
              onDismissExternal={onDismissExternal}
              onCreateLink={(target) =>
                onDialog({
                  kind: 'new',
                  initial: pathForLinkTarget(target).replace(/\.md$/i, ''),
                })
              }
              onMove={() => onDialog({ kind: 'move', path: active })}
              onDelete={() => onDialog({ kind: 'delete', path: active })}
              registerFlush={onRegisterFlush}
            />
          ) : (
            <DocumentWorkspace
              key={active}
              path={active}
              agents={agents}
              onMove={() => onDialog({ kind: 'move', path: active })}
              onDelete={() => onDialog({ kind: 'delete', path: active })}
            />
          )}
        </>
      ) : (
        <div className="bold-library-blank">
          <BookIcon size={34} />
          <b>{tree.data?.notes.length === 0 ? 'The Library is empty' : 'Pick a note'}</b>
          <span>
            {tree.data?.notes.length === 0
              ? 'Start with a note, or upload files and folders.'
              : 'Choose one on the left, or search the whole vault.'}
          </span>
        </div>
      )}
    </section>
  )
}
