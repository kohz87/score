/** Bullet characters agents (and messaging apps) use for lists that Markdown doesn't treat as list markers. */
const BULLET = /^([ \t]*)[•◦▪▫‣⁃●○■□·∙]\s+/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/

/**
 * Turns "• item" lines into Markdown list items so a reply written with bullet characters shows as a list, not one run-on
 * paragraph (owner report 2026-10-11). Indentation is kept, so "  • sub-item" nests. Fenced code is left byte for byte.
 */
export function normalizeBullets(text: string): string {
  if (!/[•◦▪▫‣⁃●○■□·∙]/.test(text)) return text
  let fence: string | null = null
  return text
    .split('\n')
    .map((line) => {
      const open = FENCE.exec(line)
      if (open) {
        const marker = open[1]!
        if (fence === null) fence = marker
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
        return line
      }
      if (fence !== null) return line
      return line.replace(BULLET, '$1- ')
    })
    .join('\n')
}
