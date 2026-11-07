import type { KeyboardEvent } from 'react'
import type { MutableRefObject } from 'react'
import { apiFetch } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import type { StartJobModel } from './start-job-model.ts'
import type { RecipeChoice } from './start-job-types.ts'
import type { StartJobState } from './use-start-job-state.ts'

export function useStartJobFormActions(
  state: StartJobState,
  model: StartJobModel,
  dialogRef: MutableRefObject<HTMLDivElement | null>,
  attemptKeyRef: MutableRefObject<string | null>,
  recipeButtonsRef: MutableRefObject<Map<string, HTMLButtonElement>>,
  onClose: () => void,
) {
  function touch() {
    state.setDirty(true)
    state.setConfirmClose(false)
    attemptKeyRef.current = null
  }

  /** One key for one attempt: a replayed request returns the first answer, and a retry never makes a second run. */
  function attemptPost(path: string, body: unknown) {
    const key = attemptKeyRef.current ?? newId()
    attemptKeyRef.current = key
    return apiFetch(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })
  }

  function requestClose() {
    if (
      (state.result?.kind === 'trigger' && !state.confirmClose) ||
      (!state.result && state.dirty)
    ) {
      state.setConfirmClose(true)
      return
    }
    onClose()
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    if (event.key !== 'Tab') return
    const controls = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      ) ?? []),
    ].filter((element) => element.tabIndex >= 0)
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || active === dialogRef.current)) {
      event.preventDefault()
      first.focus()
    }
  }

  function chooseRecipe(next: RecipeChoice) {
    state.setRecipe(next)
    state.setReachAcceptedKey(null)
    state.setCodingSteps(null)
    state.setQuotaFloor('')
    state.setConcurrent(null)
    state.setEstimate(null)
    state.setError(null)
    state.setResult(null)
    touch()
  }

  /** A real radio group: one tab stop, arrows move and choose the next chip. */
  function onRecipeKeyDown(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    const index = model.recipeOptions.findIndex((option) => option.key === key)
    if (index < 0) return
    const last = model.recipeOptions.length - 1
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return
    event.preventDefault()
    const option = model.recipeOptions[next]
    if (!option) return
    chooseRecipe(option.choice)
    recipeButtonsRef.current.get(option.key)?.focus()
  }

  function setRecipeButton(key: string, element: HTMLButtonElement | null) {
    if (element) recipeButtonsRef.current.set(key, element)
    else recipeButtonsRef.current.delete(key)
  }

  return {
    touch,
    attemptPost,
    requestClose,
    onDialogKeyDown,
    chooseRecipe,
    onRecipeKeyDown,
    setRecipeButton,
  }
}

export type StartJobFormActions = ReturnType<typeof useStartJobFormActions>
