// Formatting commands for the toolbar and the keyboard (PLAN 6.8). They only change the Markdown text, so the saved
// note is always plain Markdown.

export type {
  Active,
  CalloutType,
  InlineKind,
  LinkTarget,
  ListKind,
  TableInfo,
} from './editor-command-types.ts'
export { CALLOUT_TYPES } from './editor-command-types.ts'
export {
  activeFormats,
  setHeading,
  toggleInline,
  toggleList,
  toggleQuote,
} from './editor-format-commands.ts'
export { insertRule, setCallout, toggleCodeBlock } from './editor-block-commands.ts'
export { insertLink, linkSelectionText } from './editor-link-commands.ts'
export { insertImages } from './editor-image-commands.ts'
export {
  alignColumn,
  applyTableOp,
  canApplyTableOp,
  deleteTable,
  insertTable,
  tableAt,
  tableTab,
} from './editor-table-commands.ts'
