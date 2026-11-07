import type { Dispatch, RefObject, ReactNode, SetStateAction } from 'react'
import { ExportDialog } from '../routes/knowledge/ExportDialog.tsx'
import {
  DeleteDialog,
  FolderDeleteDialog,
  FolderMoveDialog,
  MoveDialog,
  NewFolderDialog,
  NewNoteDialog,
} from '../routes/knowledge/KnowledgeDialogs.tsx'
import { isNotePath } from '../routes/knowledge/knowledge-files.ts'
import type { useExport } from '../routes/knowledge/knowledge-export.ts'
import { baseName } from '../routes/knowledge/knowledge-paths.ts'
import {
  UnsavedDraftError,
  type useKnowledgeActions,
  type useKnowledgeInfo,
  type useKnowledgeTree,
} from '../routes/knowledge/knowledge-queries.ts'
import type { Dialog, ExportRequest } from './bold-library-model.ts'

export function BoldLibraryDialogs({
  actions,
  active,
  dialog,
  dialogError,
  exportRequest,
  exporter,
  flushRef,
  info,
  onClose,
  onDialogError,
  onOpen,
  onSelect,
  onSetCollapsed,
  onSetExportRequest,
  onSetFilesFolder,
  onSetNotice,
  onSetPickedFolder,
  onSetSection,
  tree,
  uploadDialogs,
}: {
  actions: ReturnType<typeof useKnowledgeActions>
  active: string | null
  dialog: Dialog
  dialogError: unknown
  exportRequest: ExportRequest | null
  exporter: ReturnType<typeof useExport>
  flushRef: RefObject<(() => Promise<boolean>) | null>
  info: ReturnType<typeof useKnowledgeInfo>
  onClose: () => void
  onDialogError: (error: unknown) => void
  onOpen: (path: string) => void
  onSelect: (path: string | null | undefined) => void
  onSetCollapsed: Dispatch<SetStateAction<Set<string>>>
  onSetExportRequest: (request: ExportRequest | null) => void
  onSetFilesFolder: Dispatch<SetStateAction<string>>
  onSetNotice: (notice: string) => void
  onSetPickedFolder: (folder: string) => void
  onSetSection: (section: 'notes' | 'files') => void
  tree: ReturnType<typeof useKnowledgeTree>
  uploadDialogs: ReactNode
}) {
  function create(newPath: string) {
    actions.save.mutate(
      { path: newPath, body: `# ${baseName(newPath)}\n\n`, etag: null },
      {
        onSuccess: (response) => {
          onClose()
          onOpen(response.path)
        },
        onError: onDialogError,
      },
    )
  }

  function move(from: string, to: string, updateLinks: boolean) {
    actions.move.mutate(
      { from, to, updateLinks },
      {
        onSuccess: (response) => {
          onClose()
          const left =
            response.skipped.length > 0
              ? ` Couldn’t update the links in ${response.skipped.map((item) => item.path).join(', ')}. They still link to the old name.`
              : ''
          onSetNotice(
            updateLinks
              ? `Moved to ${response.path}. Updated links in ${response.updatedNotes} ${response.updatedNotes === 1 ? 'note' : 'notes'}.${left}`
              : `Moved to ${response.path}. Links in other notes were left as they are.`,
          )
          if (from === active) onOpen(response.path)
        },
        onError: onDialogError,
      },
    )
  }

  return (
    <>
      {dialog?.kind === 'new' && (
        <NewNoteDialog
          initial={dialog.initial}
          busy={actions.save.isPending}
          error={dialogError}
          onSubmit={create}
          onClose={onClose}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          from={dialog.path}
          document={!isNotePath(dialog.path)}
          busy={actions.move.isPending}
          error={dialogError}
          onClose={onClose}
          onSubmit={(to, updateLinks) => {
            const from = dialog.path
            void (
              from === active
                ? (flushRef.current?.() ?? Promise.resolve(true))
                : Promise.resolve(true)
            ).then((saved) => {
              if (!saved) {
                onDialogError(new UnsavedDraftError())
                return
              }
              move(from, to, updateLinks)
            })
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          path={dialog.path}
          document={!isNotePath(dialog.path)}
          busy={actions.remove.isPending || actions.removeDocument.isPending}
          error={dialogError}
          onClose={onClose}
          onConfirm={() => {
            const target = dialog.path
            const mutation = isNotePath(target) ? actions.remove : actions.removeDocument
            mutation.mutate(target, {
              onSuccess: () => {
                onClose()
                onSetNotice(`Deleted ${target}.`)
                if (target === active) onSelect(null)
              },
              onError: onDialogError,
            })
          }}
        />
      )}
      {dialog?.kind === 'folder-move' && (
        <FolderMoveDialog
          from={dialog.path}
          busy={actions.moveFolder.isPending}
          error={dialogError}
          onClose={onClose}
          onSubmit={(to, updateLinks) => {
            const from = dialog.path
            // The open note is saved first, as for a note move: it may be inside the folder.
            void (flushRef.current?.() ?? Promise.resolve(true)).then((saved) => {
              if (!saved) {
                onDialogError(new UnsavedDraftError())
                return
              }
              actions.moveFolder.mutate(
                { from, to, updateLinks },
                {
                  onSuccess: (result) => {
                    onClose()
                    const moveInto = (path: string) =>
                      path === from || path.startsWith(`${from}/`)
                        ? `${to}${path.slice(from.length)}`
                        : path
                    if (active) onSelect(moveInto(active))
                    onSetFilesFolder(moveInto)
                    onSetNotice(
                      result.leftBehind.length > 0
                        ? `Moved ${result.moved} into ${to}; ${result.leftBehind.length} stayed in ${from} (${result.leftBehind.map((item) => `${item.path}: ${item.reason}`).join('; ')}).`
                        : `Moved the folder to ${to}${result.updatedNotes > 0 ? `; links updated in ${result.updatedNotes} notes` : ''}.`,
                    )
                  },
                  onError: onDialogError,
                },
              )
            })
          }}
        />
      )}
      {dialog?.kind === 'folder-delete' &&
        tree.data &&
        (() => {
          const folder = dialog.path
          const inside = (path: string) => path.startsWith(`${folder}/`)
          return (
            <FolderDeleteDialog
              path={folder}
              notes={tree.data.notes.filter((note) => inside(note.path)).length}
              files={tree.data.documents.filter((document) => inside(document.path)).length}
              unversionedFiles={
                tree.data.documents.filter(
                  (document) => inside(document.path) && !document.versioned,
                ).length
              }
              gitAvailable={info.data?.gitAvailable !== false}
              folders={tree.data.folders.filter(inside).length}
              busy={actions.removeFolderWithContents.isPending}
              error={dialogError}
              onClose={onClose}
              onConfirm={() =>
                actions.removeFolderWithContents.mutate(folder, {
                  onSuccess: (result) => {
                    onClose()
                    if (active && inside(active)) onSelect(null)
                    onSetFilesFolder((current) =>
                      current === folder || inside(current)
                        ? folder.split('/').slice(0, -1).join('/')
                        : current,
                    )
                    onSetNotice(
                      result.leftBehind.length > 0
                        ? `Deleted ${result.deleted} from ${folder}; ${result.leftBehind.length} stayed (${result.leftBehind.map((item) => `${item.path}: ${item.reason}`).join('; ')}).`
                        : `Deleted the folder ${folder}.`,
                    )
                  },
                  onError: onDialogError,
                })
              }
            />
          )
        })()}
      {dialog?.kind === 'folder' && (
        <NewFolderDialog
          parent={dialog.parent}
          busy={actions.createFolder.isPending}
          error={dialogError}
          onClose={onClose}
          onSubmit={(folder) =>
            actions.createFolder.mutate(folder, {
              onSuccess: () => {
                onClose()
                if (dialog.fromNav) {
                  onSetPickedFolder(folder)
                  onSetCollapsed((current) => {
                    const next = new Set(current)
                    next.delete(folder)
                    return next
                  })
                  return
                }
                onSetFilesFolder(folder)
                onSetSection('files')
              },
              onError: onDialogError,
            })
          }
        />
      )}
      {exportRequest && (
        <ExportDialog
          heading={exportRequest.heading}
          request={exportRequest.request}
          busy={exporter.busy}
          onClose={() => onSetExportRequest(null)}
          onExport={() =>
            void exporter.run(exportRequest.request).then((ok) => {
              if (ok) onSetExportRequest(null)
            })
          }
        />
      )}
      {uploadDialogs}
    </>
  )
}
