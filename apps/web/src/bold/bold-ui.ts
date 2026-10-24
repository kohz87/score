// Which shell this browser opens (PLAN 11.3a). Per device, never sent to the server.
export type Ui = 'bold' | 'classic'

const UI_KEY = 'score.ui'

export function readUi(): Ui {
  // Opening any Score URL with `?ui=` chooses the shell for this device before the index route decides where to go.
  try {
    applyUiParam(window.location.search)
  } catch {
    // No window (a plain module test) or blocked location access: the stored choice below still applies.
  }
  try {
    return window.localStorage.getItem(UI_KEY) === 'bold' ? 'bold' : 'classic'
  } catch {
    return 'classic'
  }
}

export function saveUi(ui: Ui): void {
  try {
    if (ui === 'bold') window.localStorage.setItem(UI_KEY, 'bold')
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
