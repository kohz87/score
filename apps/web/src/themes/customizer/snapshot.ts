// A copy of a theme is built from one snapshot (contract § 16, J1): the manifest and CSS of a draft pair only with the
// files and licences of the same package revision. The server refuses a read at an older revision (409 etag_mismatch);
// the readers turn that into this error, and the copy stops with one plain sentence.

export const THEME_CHANGED_TEXT =
  'This theme changed while you were copying it. Reload and try again.'

export class ThemeChangedError extends Error {
  constructor() {
    super(THEME_CHANGED_TEXT)
    this.name = 'ThemeChangedError'
  }
}
