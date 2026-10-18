import type { ThemeColorToken, ThemeSanitiseReport } from '@score/contract'
import type { PairProblem } from '../../themes/customizer/checks.ts'
import type { Draft, Mode } from '../../themes/customizer/draft.ts'
import type { AssetResolver } from '../../themes/engine.ts'

/** What every section of the Customizer gets: the draft, how to change it, and what the checks found. */
export type SectionContext = {
  draft: Draft
  /** Changes the draft. A `key` folds a run of changes to one control (a colour being dragged) into one undo step. */
  edit: (next: Draft, key?: string) => void
  /** The colour mode being edited; the preview shows the same one. */
  mode: Mode
  setMode: (mode: Mode) => void
  /** Score's own value of a colour token (empty until the stylesheets have been read). */
  defaults: (token: ThemeColorToken, mode: Mode) => string
  problems: PairProblem[]
  resolve: AssetResolver
  /** Said aloud to assistive technology ("Chat moved to position 2 of 7"). */
  announce: (text: string) => void
  /** What the sanitiser removed from the draft's CSS. */
  report: ThemeSanitiseReport
}
