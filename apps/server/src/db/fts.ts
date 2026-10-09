import type { DatabaseSync } from 'node:sqlite'

const INDEXABLE = 'streaming = 0 AND deleted_at IS NULL'
const BODY = `(SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(messages.parts)
           WHERE json_extract(value, '$.kind') = 'text')`

/**
 * `message_fts` is keyed on the implicit rowid of `messages` (migration 0033). A manual VACUUM, or a table rebuild,
 * can renumber those rowids and leave the index pointing at the wrong messages. Called at startup: when the index
 * disagrees with the messages it should cover, it is rebuilt. Returns whether a rebuild happened.
 */
export function ensureMessageFts(sqlite: DatabaseSync): boolean {
  const count = (sql: string) => Number((sqlite.prepare(sql).get() as { n: number | bigint }).n)
  const indexed = count('SELECT count(*) AS n FROM message_fts')
  const expected = count(`SELECT count(*) AS n FROM messages WHERE ${INDEXABLE}`)
  const strays = count(
    `SELECT count(*) AS n FROM message_fts f WHERE NOT EXISTS
       (SELECT 1 FROM messages m WHERE m.rowid = f.rowid AND m.${INDEXABLE.replaceAll(' AND ', ' AND m.')})`,
  )
  // Swapped rowids keep counts and membership intact, so compare each indexed body with its message's text too.
  const mismatched = count(
    `SELECT count(*) AS n FROM message_fts f JOIN messages ON messages.rowid = f.rowid
       WHERE f.body IS NOT ${BODY}`,
  )
  if (indexed === expected && strays === 0 && mismatched === 0) return false
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    sqlite.exec('DELETE FROM message_fts')
    sqlite.exec(
      `INSERT INTO message_fts (rowid, body)
       SELECT rowid, ${BODY}
       FROM messages WHERE ${INDEXABLE}`,
    )
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
  return true
}
