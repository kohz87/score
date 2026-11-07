import { Link } from 'react-router'
import type { RefObject } from 'react'
import { boldRecipesLink, boldStartJobLink } from './bold-links.ts'
import type { BoldRecipeEditorActions } from './use-bold-recipe-editor-actions.ts'
import type { BoldRecipeEditorState } from './use-bold-recipe-editor-state.ts'

export function BoldRecipeEditorHeader({
  state,
  actions,
  moreButton,
}: {
  state: BoldRecipeEditorState
  actions: BoldRecipeEditorActions
  moreButton: RefObject<HTMLButtonElement | null>
}) {
  const {
    archive,
    canSave,
    checkFailed,
    checking,
    commit,
    dirty,
    draft,
    graph,
    history,
    loadedFrom,
    moreOpen,
    nameId,
    navigate,
    previewBlocked,
    previewing,
    problems,
    recipe,
    remove,
    save,
    saved,
    setDeletingRuns,
    setExporting,
    setGraph,
    setMoreOpen,
    setPreviewing,
    setSel,
    setViewVersion,
    versions,
    viewVersion,
    viewing,
  } = state
  // Everything one menu holds: the steps' history, running and exporting, and the rest of what a recipe can do.
  const noRun = dirty || checking || viewing
  return (
    <>
      <div className="bold-rp-head">
        <Link className="bold-rp-back" to={boldRecipesLink()}>
          ‹ Recipes
        </Link>
        <label className="wf-visually-hidden" htmlFor={nameId}>
          Recipe name
        </label>
        <input
          id={nameId}
          className="bold-rp-name"
          value={draft.name}
          maxLength={120}
          aria-invalid={draft.name.trim() === '' || undefined}
          disabled={viewing}
          onChange={(event) => commit({ ...draft, name: event.target.value }, 'name')}
        />
        <span className="bold-rp-meta">
          {saved.workflowId === null ? 'New recipe' : `version ${saved.version}`}
          {loadedFrom !== null ? ` · editing version ${loadedFrom}` : ''}
          {dirty || saved.workflowId === null ? ' · unsaved changes' : ''}
        </span>
        {recipe?.archivedAt && <span className="bold-badge bold-badge--quiet">Archived</span>}
        <span className="bold-rp-spacer" />
        <div className="bold-seg" role="tablist" aria-label="How to show the recipe">
          <button
            type="button"
            role="tab"
            aria-selected={graph}
            className={graph ? 'on' : undefined}
            onClick={() => setGraph(true)}
          >
            Graph
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!graph}
            className={!graph ? 'on' : undefined}
            onClick={() => setGraph(false)}
          >
            As text
          </button>
        </div>
        <button
          type="button"
          className="bold-rp-pill"
          aria-label="Preview, nothing runs"
          disabled={previewing !== null || previewBlocked !== null || viewing}
          aria-describedby={previewBlocked ? 'bold-rp-preview-why' : undefined}
          title={previewBlocked ?? 'Play the recipe through without running anything'}
          onClick={() => {
            setPreviewing(draft)
            setGraph(true)
            setSel(null)
          }}
        >
          Preview
        </button>
        {previewBlocked && (
          <span id="bold-rp-preview-why" className="wf-visually-hidden">
            {previewBlocked}
          </span>
        )}
        <span className="bold-rp-more">
          <button
            type="button"
            className="bold-rp-dots"
            ref={moreButton}
            aria-label="More"
            aria-haspopup="true"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((value) => !value)}
          >
            ⋯
          </button>
          {moreOpen && (
            <div className="bold-rp-morepanel" role="group" aria-label="More">
              <div className="bold-rp-morerow">
                <button
                  type="button"
                  className="btn sm"
                  disabled={!history.canUndo || viewing || previewing !== null}
                  onClick={history.undo}
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={!history.canRedo || viewing || previewing !== null}
                  onClick={history.redo}
                >
                  Redo
                </button>
              </div>
              {saved.workflowId !== null && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={noRun}
                  title={dirty ? 'Save first: a run uses a saved version' : undefined}
                  onClick={() => void navigate(boldStartJobLink(saved.workflowId!))}
                >
                  Run…
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={!saved.workflowId || dirty}
                title={
                  !saved.workflowId
                    ? 'Save the recipe first: the export is a saved version.'
                    : dirty
                      ? 'Save first: the export is a saved version.'
                      : undefined
                }
                onClick={() => {
                  setMoreOpen(false)
                  setExporting(true)
                }}
              >
                Export
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!saved.workflowId || dirty || save.isPending}
                title={dirty ? 'Save first: a copy is made from the saved version.' : undefined}
                onClick={actions.duplicate}
              >
                Duplicate
              </button>
              {versions.length > 0 && (
                <label className="bold-lab">
                  View a saved version (read-only)
                  <select
                    className="bold-field"
                    value={viewVersion ?? ''}
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      setViewVersion(value || null)
                      setGraph(true)
                      setSel(null)
                      setPreviewing(null)
                      setMoreOpen(false)
                    }}
                  >
                    <option value="">Choose a version…</option>
                    {[...versions].reverse().map((version) => (
                      <option key={version.version} value={version.version}>
                        Version {version.version}
                        {version.used ? ' (used by runs)' : ''}, {version.nodes} steps
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {saved.workflowId && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={archive.isPending}
                  onClick={actions.toggleArchive}
                >
                  {recipe?.archivedAt ? 'Unarchive' : 'Archive'}
                </button>
              )}
              {saved.workflowId && !recipe?.used && (
                <button
                  type="button"
                  className="btn sm bold-danger"
                  disabled={remove.isPending}
                  onClick={actions.removeRecipe}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete recipe'}
                </button>
              )}
              {saved.workflowId && recipe?.used && (
                <button
                  type="button"
                  className="btn sm bold-danger"
                  onClick={() => {
                    setMoreOpen(false)
                    setDeletingRuns(true)
                  }}
                >
                  Delete with runs…
                </button>
              )}
            </div>
          )}
        </span>
        <button
          type="button"
          className="bold-rp-save"
          disabled={!canSave}
          aria-label={save.isPending ? 'Saving…' : `Save as version ${saved.version + 1}`}
          title={
            problems.length > 0
              ? 'Fix the problems first'
              : checkFailed
                ? "Score couldn't check this recipe. Try again before saving."
                : checking
                  ? 'Score is still checking the recipe'
                  : undefined
          }
          onClick={actions.onSave}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {recipe?.archivedAt && (
        <p className="small muted bold-rp-archived-note" role="status">
          Archived: this recipe is hidden from the library’s list and not offered in Start a job.
          Its past runs still open.{' '}
          <button type="button" className="bold-link" onClick={actions.toggleArchive}>
            Unarchive
          </button>
        </p>
      )}
    </>
  )
}
