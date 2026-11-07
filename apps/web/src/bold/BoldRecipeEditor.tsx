import { useRef } from 'react'
import { ExportDialog } from '../routes/workflows/ExportDialog.tsx'
import type { BoldRecipeEditorProps } from './bold-recipe-editor-model.ts'
import { BoldRecipeEditorHeader } from './BoldRecipeEditorHeader.tsx'
import { BoldRecipeEditorStatus } from './BoldRecipeEditorStatus.tsx'
import { BoldRecipeWorkspace } from './BoldRecipeWorkspace.tsx'
import { useBoldRecipeEditorActions } from './use-bold-recipe-editor-actions.ts'
import { useBoldRecipeEditorFocus } from './use-bold-recipe-editor-focus.ts'
import { useBoldRecipeEditorState } from './use-bold-recipe-editor-state.ts'

// PLAN 11.10d, rebuilt as a page in 2.8.0 (decision 131, board C) and as a library in 3.29.0 (decision 165, mock-ups
// 23-recipes-*). A recipe is a 7.1 workflow: Settings > Recipes lists them as cards next to the built-in "lead decides"
// (BoldRecipeLibrary.tsx); this file is the editor for one: a graph (the full editor: add, connect, move, delete,
// keyboard on the canvas, preview, live states of a running copy) or "As text" (the step list). The step settings sit to
// the right of both (a bottom sheet on a phone). Starting a run stays in Start a job (Run opens it with this recipe
// chosen). A run is read in its chat; only one that belongs to no chat opens a read-only sheet over the library.

export function BoldRecipeEditor(props: BoldRecipeEditorProps) {
  const root = useRef<HTMLElement>(null)
  const allowLeave = useRef(false)
  const skipSheetFocus = useRef(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  const aside = useRef<HTMLElement>(null)
  const state = useBoldRecipeEditorState(props, allowLeave)
  const focus = useBoldRecipeEditorFocus(state, { root, skipSheetFocus, aside })
  const actions = useBoldRecipeEditorActions(props, state, focus, {
    setAllowLeave: (value) => {
      allowLeave.current = value
    },
    setSkipSheetFocus: (value) => {
      skipSheetFocus.current = value
    },
    focusMoreButton: () => moreButton.current?.focus(),
  })
  return (
    <div className="bold-rp bold-re" data-ui-page="recipes">
      <section
        ref={root}
        className={`bold-rp-editor${focus.sheet && state.graphNode ? ' bold-rp-main--sheet' : ''}`}
        aria-label="Recipe editor"
        tabIndex={-1}
        onKeyDown={actions.onKeyDown}
      >
        <BoldRecipeEditorHeader state={state} actions={actions} moreButton={moreButton} />
        <BoldRecipeEditorStatus
          detail={props.detail}
          notice={props.notice}
          state={state}
          actions={actions}
        />
        <BoldRecipeWorkspace state={state} focus={focus} actions={actions} aside={aside} />
      </section>

      {state.exporting && state.saved.workflowId && (
        <ExportDialog
          workflowId={state.saved.workflowId}
          version={state.saved.version}
          name={state.draft.name}
          close={() => state.setExporting(false)}
        />
      )}
    </div>
  )
}
