import { expect, test } from 'vitest'
import { db, setupRewindTest } from './rewind-helpers.ts'

setupRewindTest()

test('migration 0036 adds versions, the message version link and the run rewind mark', () => {
  const columns = (table: string) =>
    (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    )
  expect(columns('room_versions')).toEqual(
    expect.arrayContaining(['anchor_id', 'mode', 'score_only', 'hidden_count', 'replaced_by']),
  )
  expect(columns('messages')).toContain('version_id')
  expect(columns('message_runs')).toContain('rewound_at')
})
