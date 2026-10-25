// Which shell this browser opens (PLAN 11.3a). Per device, never sent to the server.
import type { Dispatch, SetStateAction } from 'react'

export type Ui = 'bold' | 'classic'

/** The phone side sheet is owned by the shell (so the header and tab bar can go inert) but opened by the room. */
export type BoldSheetState = {
  sheetOpen: boolean
  setSheetOpen: Dispatch<SetStateAction<boolean>>
}

const UI_KEY = 'score.ui'

export function readUi(): Ui {
  // Opening any Score URL with `?ui=` chooses the shell for this device before the index route decides where to go.
  try {
    applyUiParam(window.location.search)
  } catch {
    // No window (a plain module test) or blocked location access: the stored choice below still applies.
  }
  try {
    return window.localStorage.getItem(UI_KEY) === 'classic' ? 'classic' : 'bold'
  } catch {
    return 'bold'
  }
}

export function saveUi(ui: Ui): void {
  try {
    // Bold is the default, so only the exception needs a stored value.
    if (ui === 'classic') window.localStorage.setItem(UI_KEY, 'classic')
    else window.localStorage.removeItem(UI_KEY)
  } catch {
    // Blocked storage still chooses for this visit.
  }
}

/** Applies `?ui=bold` or `?ui=classic` from any address; anything else leaves the stored choice alone. */
export function applyUiParam(search: string): void {
  const ui = new URLSearchParams(search).get('ui')
  if (ui === 'bold') saveUi('bold')
  else if (ui === 'classic') saveUi('classic')
}
