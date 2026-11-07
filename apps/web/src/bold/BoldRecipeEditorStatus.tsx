import type { WorkflowDetail } from '@score/contract'
import { DeleteWithRunsDialog } from './DeleteWithRunsDialog.tsx'
import { describeError, problemTarget } from './bold-recipe-editor-model.ts'
import type { BoldRecipeEditorActions } from './use-bold-recipe-editor-actions.ts'
import type { BoldRecipeEditorState } from './use-bold-recipe-editor-state.ts'

export function BoldRecipeEditorStatus({
  detail,
  notice,
  state,
  actions,
}: {
  detail: WorkflowDetail | null
  notice: string
  state: BoldRecipeEditorState
  actions: BoldRecipeEditorActions
}) {
  const {
    allProblems,
    allProblemsId,
    announcement,
    badge,
    checkFailed,
    conflict,
    deletingRuns,
    draft,
    graphDraft,
    problems,
    removeWithRuns,
    runCount,
    saveProblem,
    saved,
    selectNode,
    setAllProblems,
    setViewVersion,
    viewed,
    viewVersion,
    viewing,
    warnings,
  } = state
  const problem = problems[0]
  const problemTargetId = problem ? problemTarget(problem, graphDraft) : null
  const status = checkFailed ? 'bad' : problems.length > 0 ? 'bad' : 'ok'
  return (
    <>
      <p className="wf-visually-hidden" role="status">
        {badge}
      </p>
      {(problems.length > 0 || checkFailed) && (
        <div className="bold-rp-problem" data-status={status}>
          <p>
            <b>
              {checkFailed && problems.length === 0
                ? 'Score couldn’t check this recipe.'
                : `${problems.length} ${problems.length === 1 ? 'thing' : 'things'} to fix before saving:`}
            </b>{' '}
            {problem?.message}
            {problemTargetId && (
              <>
                {' '}
                <button
                  type="button"
                  className="bold-link"
                  onClick={() => selectNode(problemTargetId)}
                >
                  Show it
                </button>
              </>
            )}
            {problems.length > 1 && (
              <>
                {' · '}
                <button
                  type="button"
                  className="bold-link"
                  aria-expanded={allProblems}
                  aria-controls={allProblemsId}
                  onClick={() => setAllProblems((open) => !open)}
                >
                  {allProblems ? 'Hide' : 'Show all'}
                </button>
              </>
            )}
          </p>
          {allProblems && problems.length > 1 && (
            <ul id={allProblemsId} aria-label="All problems">
              {problems.map((item, index) => {
                const target = problemTarget(item, graphDraft)
                return (
                  <li key={`${item.code}-${item.nodeId ?? item.edgeId ?? ''}-${index}`}>
                    {item.message}
                    {target && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="bold-link"
                          onClick={() => selectNode(target)}
                        >
                          Show it
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {problems.length === 0 && warnings > 0 && (
        <p className="small muted">
          {warnings} {warnings === 1 ? 'warning' : 'warnings'} — saving is still allowed.
        </p>
      )}
      {notice && (
        <p className="small muted bold-recipes-notice" role="status">
          {notice}
        </p>
      )}
      <p className="wf-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {deletingRuns && saved.workflowId && (
        <DeleteWithRunsDialog
          name={detail?.name ?? draft.name}
          runs={runCount}
          pending={removeWithRuns.isPending}
          error={removeWithRuns.isError ? describeError(removeWithRuns.error) : ''}
          onCancel={actions.cancelDeleteWithRuns}
          onConfirm={actions.confirmDeleteWithRuns}
        />
      )}

      {conflict !== null && (
        <section
          role="alert"
          data-protected="block"
          className="bold-inner bold-recipes-conflict"
          aria-label="Someone saved first"
        >
          <b>A newer version exists</b>
          <p>
            Version {conflict} was saved while you were editing version {saved.version}, from
            another tab or window. Your changes are still here and nothing was overwritten.
          </p>
          <div className="row wrap">
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void actions.reloadLatest(conflict)}
            >
              Reload version {conflict} (discard my edits)
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => actions.keepDraftOnConflict(conflict)}
            >
              Keep my draft and build on version {conflict}
            </button>
          </div>
        </section>
      )}

      {saveProblem && (
        <p role="alert" className="bold-error">
          {saveProblem}
        </p>
      )}

      {viewing && (
        <section className="bold-inner bold-recipes-graphnote" aria-label="Viewing a saved version">
          <b>Version {viewVersion} (read-only)</b>
          <p>A saved version never changes. Edit a copy of it to make a new version.</p>
          <div className="row wrap">
            <button
              type="button"
              className="btn sm primary"
              disabled={!viewed.data}
              onClick={() => void actions.loadOlder(viewVersion!)}
            >
              Edit a copy of version {viewVersion}
            </button>
            <button type="button" className="btn sm" onClick={() => setViewVersion(null)}>
              Back to my draft
            </button>
          </div>
          {viewed.isError && (
            <p role="alert" className="bold-error">
              Couldn’t load that version.
            </p>
          )}
        </section>
      )}
    </>
  )
}
