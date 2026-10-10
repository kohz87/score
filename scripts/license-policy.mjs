// The license policy of AGENTS.md (dependency rule 4), exactly: MIT, Apache-2.0, BSD-2/3-Clause, ISC; SIL OFL-1.1 only
// for font packages. Anything else needs an owner-approved entry in license-exceptions.json.
export const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'])
export const FONT_LICENSES = new Set(['OFL-1.1'])
export const FONT_SCOPES = ['@fontsource/']

/** True if an SPDX expression is satisfiable with allowed ids (OR = any branch, AND = all parts). */
export function permitted(expr, isFont) {
  const ok = (id) => ALLOWED.has(id) || (isFont && FONT_LICENSES.has(id))
  const clean = String(expr).replace(/[()]/g, ' ').trim()
  return clean
    .split(/\s+OR\s+/i)
    .some((branch) => branch.split(/\s+AND\s+/i).every((id) => ok(id.trim())))
}
