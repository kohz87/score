import { useRef } from 'react'

export function useStartJobRefs() {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const authInputRef = useRef<HTMLInputElement>(null)
  const attemptKeyRef = useRef<string | null>(null)
  const stoppedForStartRef = useRef<string | null>(null)
  const startingRef = useRef(false)
  const savedRecipeNameRef = useRef<string | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const recipeButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  return {
    dialogRef,
    closeButtonRef,
    authInputRef,
    attemptKeyRef,
    stoppedForStartRef,
    startingRef,
    savedRecipeNameRef,
    returnFocusRef,
    recipeButtonsRef,
  }
}

export type StartJobRefs = ReturnType<typeof useStartJobRefs>
