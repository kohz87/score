import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useMediaQuery } from '../data/use-media.ts'
import { layoutRecipe } from '../routes/workflows/recipe-layers.ts'
import type { BoldRecipeEditorState } from './use-bold-recipe-editor-state.ts'

// The bold shell's narrow breakpoint: below it the step settings are a bottom sheet (a tablet gets it too).
const NARROW_QUERY = '(width <= 860px)'

export function useBoldRecipeEditorFocus(
  state: BoldRecipeEditorState,
  {
    root,
    skipSheetFocus,
    aside,
  }: {
    root: RefObject<HTMLElement | null>
    skipSheetFocus: RefObject<boolean>
    aside: RefObject<HTMLElement | null>
  },
) {
  const { graphNode, graphDraft, previewing, selectNode } = state

  function focusStep(id: string | null, control: 'row' | 'up' | 'down') {
    requestAnimationFrame(() => {
      if (id === null) {
        root.current?.focus()
        return
      }
      const row = root.current?.querySelector<HTMLElement>(`[data-recipe-step="${id}"]`)
      if (control === 'row') {
        row?.querySelector<HTMLButtonElement>('.bold-step')?.focus()
        return
      }
      const wanted = row?.querySelector<HTMLButtonElement>(`[data-move="${control}"]`)
      const other = row?.querySelector<HTMLButtonElement>(
        `[data-move="${control === 'up' ? 'down' : 'up'}"]`,
      )
      const target = wanted && !wanted.disabled ? wanted : other
      if (target && !target.disabled) target.focus()
      else row?.querySelector<HTMLButtonElement>('.bold-step')?.focus()
    })
  }

  function focusCard(id: string | null) {
    requestAnimationFrame(() => {
      skipSheetFocus.current = false
      if (id === null) {
        root.current?.focus()
        return
      }
      root.current?.querySelector<HTMLElement>(`.rl-card[data-node="${CSS.escape(id)}"]`)?.focus()
    })
  }

  const narrow = useMediaQuery(NARROW_QUERY)
  // Below 860px (phone and tablet) the step's settings are a sheet from the bottom, as in the mock-up (both views); only while a step is selected.
  const sheet = narrow && previewing === null
  const recipeLayout = useMemo(() => layoutRecipe(graphDraft), [graphDraft])
  const sheetOpen = sheet && graphNode !== undefined
  const graphId = graphNode?.id ?? null
  const sheetCard = useRef<string | null>(null)
  useEffect(() => {
    if (sheetOpen) sheetCard.current = graphId
  }, [sheetOpen, graphId])
  // The sheet takes focus when it opens and gives it back to the card when it closes; the selected card is scrolled into
  // view above it (the cards keep a bottom margin the height of the sheet).
  useEffect(() => {
    if (sheetOpen) {
      if (!skipSheetFocus.current) aside.current?.focus()
    } else if (sheetCard.current) {
      focusCard(sheetCard.current)
      sheetCard.current = null
    }
    // focusCard and the refs only read the DOM, so the sheet transition is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen])
  useEffect(() => {
    if (!sheetOpen || graphId === null) return
    const frame = requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLElement>(`.rl-card[data-node="${CSS.escape(graphId)}"]`)
        ?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
    // root is stable; the sheet and selected card are the triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen, graphId])
  // Escape closes the sheet wherever focus is, unless something inside (a menu, a field's suggestions) used it.
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) selectNode(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sheetOpen, selectNode])

  return { focusStep, focusCard, sheet, recipeLayout }
}

export type BoldRecipeEditorFocus = ReturnType<typeof useBoldRecipeEditorFocus>
