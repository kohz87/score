export type ThemeChoice = 'light' | 'dark' | 'system'
export const themeChoices: ThemeChoice[] = ['light', 'dark', 'system']
const STORAGE_KEY = 'score.theme'

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

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Private windows and blocked storage still switch for this visit.
  }
  applyTheme(choice)
}
