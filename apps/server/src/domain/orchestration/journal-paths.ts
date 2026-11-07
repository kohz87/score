export const JOURNAL_FILE = 'journal.ndjson'
export const RESTORE_MARKER_FILE = 'restore-marker.json'
/** FZ3 #13: written before the first record of a namespace; its presence says "this folder has execution history". */
export const HISTORY_MARKER_FILE = 'history.json'
/** v3.1: a size alarm at 50 MB (compaction removes reconciled entries daily; unresolved ones are never dropped). */
export const JOURNAL_SIZE_ALARM_BYTES = 50 * 1024 * 1024
