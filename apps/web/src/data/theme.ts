export type ThemeChoice = 'light' | 'dark' | 'system'
export const themeChoices: ThemeChoice[] = ['light', 'dark', 'system']
const STORAGE_KEY = 'score.theme'
/** Fired on window when this device's colour mode changes, so the look runtime re-reads it. */
export const THEME_CHANGED = 'score:theme-changed'

export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Light and dark pin `data-theme`; System leaves it unset so the stylesheet follows the OS. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}

/** What this device chose, or null when it follows the shared colour mode (Settings › Look). */
export function readStoredTheme(): ThemeChoice | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' || value === 'system' ? value : null
  } catch {
    return null
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Private windows and blocked storage still switch for this visit.
  }
  applyTheme(choice)
  window.dispatchEvent(new Event(THEME_CHANGED))
}
