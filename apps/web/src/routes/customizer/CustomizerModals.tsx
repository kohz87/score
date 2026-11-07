import type { QueryClient } from '@tanstack/react-query'
import type { ThemeSummary } from '@score/contract'
import type { Blocker, NavigateFunction } from 'react-router'
import { freshId, type Draft } from '../../themes/customizer/draft.ts'
import { themesKey } from '../../themes/queries.ts'
import { Modal } from './controls.tsx'
import type { ImportCandidate } from './ImportDialog.tsx'
import { ImportDialog } from './ImportDialog.tsx'

type ModalsProps = {
  saveAs: string | null
  setSaveAs: (value: string | null) => void
  saveNew: (name: string) => void
  takenIds: string[]
  askStart: string | null
  setAskStart: (value: string | null) => void
  startFrom: (id: string) => void
  candidate: ImportCandidate | null
  setCandidate: (candidate: ImportCandidate | null) => void
  themes: ThemeSummary[]
  queryClient: QueryClient
  navigate: NavigateFunction
  draft: Draft
  blocker: Blocker
}

export function CustomizerModals({
  saveAs,
  setSaveAs,
  saveNew,
  takenIds,
  askStart,
  setAskStart,
  startFrom,
  candidate,
  setCandidate,
  themes,
  queryClient,
  navigate,
  draft,
  blocker,
}: ModalsProps) {
  return (
    <>
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
    </>
  )
}
