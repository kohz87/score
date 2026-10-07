import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ZodError } from 'zod'
import {
  closeReadOnly,
  HermesSchemaDrift,
  openReadOnly,
  recentSessions,
  reconcileRecent,
  reconcileSession,
  revisionIdentity,
  type SessionReconciliation,
} from '../../../src/hermes/live/index.ts'
import {
  createFixtureHome,
  insertSession,
  insertSessionMessage,
} from '../../fixtures/hermes/sqlite-fixture.ts'

let fixtures: ReturnType<typeof createFixtureHome>
const readers: DatabaseSync[] = []

beforeEach(() => {
  fixtures = createFixtureHome()
})

afterEach(() => {
  for (const reader of readers.splice(0)) closeReadOnly(reader)
  fixtures.close()
})

function setup() {
  const { db, path } = fixtures.build('state')
  insertSession(db)
  const reader = openReadOnly(path)
  readers.push(reader)
  return { db, reader, read: () => reconcileSession(reader, { sessionId: 'session-1' }) }
}

function seedMessages(db: DatabaseSync) {
  insertSessionMessage(db, { messageUid: 'message-1', role: 'user', content: 'Example request' })
  insertSessionMessage(db, { messageUid: 'message-2' })
  insertSessionMessage(db, { messageUid: 'message-3', role: 'tool', content: 'Example result' })
}

function identities(result: SessionReconciliation) {
  return [...result.messages, result.roster].map((revision) =>
    revisionIdentity('builder', 'fixture-incarnation', revision),
  )
}

test('content edits change only the edited message revision and identity', () => {
  const { db, read } = setup()
  seedMessages(db)
  const before = read()
  db.prepare('UPDATE messages SET content = ? WHERE message_uid = ?').run(
    'Edited reply',
    'message-2',
  )
  const after = read()
  expect(after.messages[0]).toEqual(before.messages[0])
  expect(after.messages[2]).toEqual(before.messages[2])
  expect(after.messages[1]!.contentHash).not.toBe(before.messages[1]!.contentHash)
  expect(after.messages[1]!.revision).not.toBe(before.messages[1]!.revision)
  expect(identities(after)[1]).not.toBe(identities(before)[1])
  expect(after.roster).toEqual(before.roster)
  expect(after.malformed).toBe(0)
})

test('rewind and undo change flags and roster without changing content hashes', () => {
  const { db, read } = setup()
  seedMessages(db)
  const before = read()
  db.exec('UPDATE messages SET active = 0 WHERE id >= 2')
  const rewound = read()
  expect(rewound.messages[0]).toEqual(before.messages[0])
  for (const index of [1, 2]) {
    expect(rewound.messages[index]).toMatchObject({
      active: false,
      contentHash: before.messages[index]!.contentHash,
      revision: `00:${before.messages[index]!.contentHash.slice(0, 16)}`,
    })
    expect(identities(rewound)[index]).not.toBe(identities(before)[index])
  }
  expect(rewound.roster.liveLogicalIds).toEqual(['message-1'])
  expect(rewound.roster.revision).not.toBe(before.roster.revision)
  expect(read()).toEqual(rewound)
  db.exec('UPDATE messages SET active = 1 WHERE id >= 2')
  expect(read()).toEqual(before)
})

test('compaction flips revisions and an older carried copy preserves one logical message and roster', () => {
  const { db, read } = setup()
  seedMessages(db)
  const before = read()
  db.exec("UPDATE messages SET compacted = 1 WHERE message_uid = 'message-2'")
  const compacted = read()
  expect(compacted.messages[1]!.revision).toBe(`11:${before.messages[1]!.contentHash.slice(0, 16)}`)
  expect(compacted.roster).toEqual(before.roster)
  const carriedId = insertSessionMessage(db, {
    messageUid: 'message-2',
    content: 'Carried reply',
    timestamp: 500,
    compacted: 1,
  })
  const carried = read()
  expect(carried.messages).toHaveLength(3)
  expect(carried.messages[1]).toMatchObject({
    logicalId: 'message-2',
    physicalId: carriedId,
    physicalIds: [2, carriedId],
    active: true,
    compacted: true,
  })
  expect(carried.messages[1]!.contentHash).not.toBe(compacted.messages[1]!.contentHash)
  expect(carried.roster).toEqual(before.roster)
  expect(read()).toEqual(carried)
})

test('highest active physical row wins over newer inactive copies; highest ID wins when none is active', () => {
  const { db, read } = setup()
  insertSessionMessage(db, { messageUid: 'message-1', content: 'First reply', timestamp: 3000 })
  const activeId = insertSessionMessage(db, {
    messageUid: 'message-1',
    content: 'Active reply',
    timestamp: 1000,
  })
  const inactiveId = insertSessionMessage(db, {
    messageUid: 'message-1',
    content: 'Inactive reply',
    active: 0,
    compacted: 1,
  })
  expect(read().messages).toMatchObject([
    {
      physicalId: activeId,
      physicalIds: [1, activeId, inactiveId],
      active: true,
      compacted: false,
    },
  ])
  db.exec('UPDATE messages SET active = 0')
  const inactive = read()
  expect(inactive.messages).toMatchObject([
    {
      physicalId: inactiveId,
      physicalIds: [1, activeId, inactiveId],
      active: false,
      compacted: true,
    },
  ])
  expect(inactive.roster.liveLogicalIds).toEqual([])
})

test('hard deletion changes the roster and deletion of an inactive copy preserves it', () => {
  const { db, read } = setup()
  seedMessages(db)
  const copy = insertSessionMessage(db, { messageUid: 'message-1', active: 0 })
  const before = read()
  db.prepare('DELETE FROM messages WHERE id = ?').run(copy)
  expect(read().roster).toEqual(before.roster)
  db.exec("DELETE FROM messages WHERE message_uid = 'message-3'")
  const after = read()
  expect(after.messages).toHaveLength(2)
  expect(after.roster.liveLogicalIds).toEqual(['message-1', 'message-2'])
  expect(after.roster.revision).not.toBe(before.roster.revision)
  db.exec('DELETE FROM messages')
  expect(read().roster.liveLogicalIds).toEqual([])
  expect(read().roster.revision).toBe(createHash('sha256').update('[]').digest('hex'))
})

test('unchanged revisions are identical on re-run and identities are namespaced by kind, profile and incarnation', () => {
  const { db, read } = setup()
  seedMessages(db)
  const first = read()
  const second = read()
  expect(second).toEqual(first)
  expect(identities(second)).toEqual(identities(first))
  expect(new Set(identities(first)).size).toBe(4)
  const message = first.messages[0]!
  expect(revisionIdentity('builder', 'fixture-incarnation', message)).toBe(
    `message:builder:fixture-incarnation:message-1@${message.revision}`,
  )
  expect(revisionIdentity('builder', 'fixture-incarnation', first.roster)).toBe(
    `roster:builder:fixture-incarnation:session-1@${first.roster.revision}`,
  )
  expect(revisionIdentity('reviewer', 'fixture-incarnation', message)).not.toBe(
    identities(first)[0],
  )
  expect(revisionIdentity('builder', 'restored-incarnation', message)).not.toBe(
    identities(first)[0],
  )
})

test('legacy null message UIDs use physical IDs without merging rows', () => {
  const { db, read } = setup()
  seedMessages(db)
  // The fixture trigger mints UIDs on insert, so simulate legacy rows after insertion.
  db.exec('UPDATE messages SET message_uid = NULL')
  expect(read().messages.map((message) => message.logicalId)).toEqual(['id:1', 'id:2', 'id:3'])
  expect(read().messages.map((message) => message.physicalIds)).toEqual([[1], [2], [3]])
  expect(identities(read())).toEqual(identities(read()))
})

test('absent optional identity and reasoning columns work like null columns', () => {
  const { db, read } = setup()
  seedMessages(db)
  db.exec('UPDATE messages SET message_uid = NULL')
  const before = read()
  db.exec(`DROP TRIGGER messages_message_uid_insert;
    DROP INDEX idx_messages_session_uid;
    ALTER TABLE messages DROP COLUMN message_uid;
    ALTER TABLE messages DROP COLUMN tool_call_uid;
    ALTER TABLE messages DROP COLUMN tool_call_uids;
    ALTER TABLE messages DROP COLUMN reasoning;`)
  expect(read()).toEqual(before)
})

test('content hash uses canonical JSON and includes non-null reasoning', () => {
  const { db, read } = setup()
  insertSessionMessage(db, { messageUid: 'message-1' })
  const before = read().messages[0]!
  expect(before.contentHash).toBe(
    createHash('sha256')
      .update('{"content":"Example reply","tool_call_id":null,"tool_calls":null,"tool_name":null}')
      .digest('hex'),
  )
  expect(before.revision).toBe(`10:${before.contentHash.slice(0, 16)}`)
  db.exec("UPDATE messages SET reasoning = 'Example reasoning'")
  const reasoning = read().messages[0]!
  expect(reasoning.contentHash).toBe(
    createHash('sha256')
      .update(
        '{"content":"Example reply","reasoning":"Example reasoning","tool_call_id":null,"tool_calls":null,"tool_name":null}',
      )
      .digest('hex'),
  )
  expect(reasoning.revision).not.toBe(before.revision)
  db.exec("UPDATE messages SET reasoning = ''")
  expect(read().messages[0]!.contentHash).not.toBe(before.contentHash)
  db.exec('UPDATE messages SET reasoning = NULL')
  expect(read().messages[0]).toEqual(before)
})

test('tool-call JSON key order and whitespace do not change revisions; payload edits do', () => {
  const { db, read } = setup()
  insertSessionMessage(db, {
    messageUid: 'message-1',
    toolCalls: '[{"id":"call-1","function":{"name":"example","arguments":"{}"}}]',
  })
  const before = read()
  db.prepare('UPDATE messages SET tool_calls = ?').run(
    '[ { "function": {"arguments":"{}", "name":"example"}, "id":"call-1"} ]',
  )
  expect(read()).toEqual(before)
  db.prepare('UPDATE messages SET tool_calls = ?').run(
    '[{"id":"call-1","function":{"name":"changed","arguments":"{}"}}]',
  )
  expect(read().messages[0]!.revision).not.toBe(before.messages[0]!.revision)
})

test.each(['tool_call_id', 'tool_name'])('%s edits change content revisions', (column) => {
  const { db, read } = setup()
  insertSessionMessage(db, { messageUid: 'message-1' })
  const before = read()
  db.prepare(`UPDATE messages SET ${column} = ?`).run('example')
  expect(read().messages[0]!.revision).not.toBe(before.messages[0]!.revision)
})

test('tool results prefer stable UIDs and older rows fall back to provider IDs', () => {
  const { db, read } = setup()
  insertSessionMessage(db, {
    messageUid: 'message-1',
    role: 'tool',
    toolCallId: 'provider-call',
    toolCallUid: 'stable-tool',
  })
  insertSessionMessage(db, {
    messageUid: 'message-2',
    role: 'tool',
    toolCallId: 'legacy-call',
  })
  expect(read().messages.map((message) => message.toolCallIds)).toEqual([
    ['stable-tool'],
    ['legacy-call'],
  ])
})

test('assistant tool calls use stable UID maps, preserve merged occurrences and fall back per call', () => {
  const { db, read } = setup()
  insertSessionMessage(db, {
    messageUid: 'message-1',
    toolCalls: '[{"id":"call-1"},{"id":"call-2"},{"id":"call-1"},{"id":"call-3"}]',
    toolCallUids:
      '{"call-1":["tool-b","tool-a","tool-b"],"call-2":"tool-c","stale-call":"stale-tool"}',
  })
  expect(read().messages[0]!.toolCallIds).toEqual(['call-3', 'tool-a', 'tool-b', 'tool-c'])
  expect(read().malformed).toBe(0)
  expect(identities(read())).toEqual(identities(read()))
})

test('carried tool results retain the stable UID of the selected physical row', () => {
  const { db, read } = setup()
  insertSessionMessage(db, {
    messageUid: 'message-1',
    role: 'tool',
    toolCallId: 'provider-old',
    toolCallUid: 'stable-tool',
  })
  insertSessionMessage(db, {
    messageUid: 'message-1',
    role: 'tool',
    toolCallId: 'provider-new',
    toolCallUid: 'stable-tool',
    timestamp: 500,
  })
  insertSessionMessage(db, {
    messageUid: 'message-1',
    role: 'tool',
    toolCallUid: 'inactive-tool',
    active: 0,
  })
  expect(read().messages).toMatchObject([
    { physicalId: 2, physicalIds: [1, 2, 3], toolCallIds: ['stable-tool'] },
  ])
})

test.each(['{bad', '{"call-1":42}'])(
  'malformed tool UID maps %s count a row once and retain provider fallback',
  (toolCallUids) => {
    const { db, read } = setup()
    insertSessionMessage(db, {
      messageUid: 'message-1',
      toolCalls: '[{"id":"call-1"}]',
      toolCallUids,
    })
    expect(read().malformed).toBe(1)
    expect(read().messages[0]!.toolCallIds).toEqual(['call-1'])
    db.exec("UPDATE messages SET tool_calls = '{bad calls'")
    expect(read().malformed).toBe(1)
  },
)

test('reconciliation is scoped to a session and rosters sort logical IDs', () => {
  const { db, reader, read } = setup()
  insertSession(db, 'session-2')
  for (const messageUid of ['z-message', 'a-message', 'm-message'])
    insertSessionMessage(db, { messageUid })
  insertSessionMessage(db, {
    sessionId: 'session-2',
    messageUid: 'a-message',
    content: 'Other session',
  })
  expect(read().messages).toHaveLength(3)
  expect(read().roster.liveLogicalIds).toEqual(['a-message', 'm-message', 'z-message'])
  expect(read().roster.revision).toBe(
    createHash('sha256').update('["a-message","m-message","z-message"]').digest('hex'),
  )
  expect(reconcileSession(reader, { sessionId: 'session-2' }).messages).toHaveLength(1)
  expect(reconcileSession(reader, { sessionId: 'missing' }).messages).toEqual([])
  expect(() => reader.exec('DELETE FROM messages')).toThrow(/readonly/)
})

test('malformed scalar rows are counted and skipped without failing a session', () => {
  const { db, read } = setup()
  seedMessages(db)
  db.exec(
    "UPDATE messages SET active = 2 WHERE id = 2; UPDATE messages SET timestamp = 'bad' WHERE id = 3;",
  )
  const result = read()
  expect(result.malformed).toBe(2)
  expect(result.messages.map((message) => message.logicalId)).toEqual(['message-1'])
  expect(result.roster.liveLogicalIds).toEqual(['message-1'])
})

test('malformed JSON is retained as a stable revision and counted', () => {
  const { db, read } = setup()
  insertSessionMessage(db, { messageUid: 'message-1', toolCalls: '{bad json' })
  expect(read().malformed).toBe(1)
  expect(read().messages).toHaveLength(1)
  expect(identities(read())).toEqual(identities(read()))
  const before = read()
  db.prepare('UPDATE messages SET tool_calls = ?').run('{different bad json')
  expect(read().messages[0]!.revision).not.toBe(before.messages[0]!.revision)
})

test('recent sessions use either activity marker, inclusive boundaries and start only as a null fallback', () => {
  const { db, reader } = setup()
  db.exec('DELETE FROM sessions')
  const rows = [
    ['activity', 0, 200, null],
    ['ended', 0, 10, 300],
    ['started', 250, null, null],
    ['boundary', 100, 100, null],
    ['old', 0, 99, 99],
    ['start-is-not-activity', 500, 10, null],
    ['start-is-not-ended', 500, null, 10],
  ] as const
  for (const [id, startedAt, lastActivityAt, endedAt] of rows) {
    insertSession(db, id)
    db.prepare(
      'UPDATE sessions SET started_at = ?, last_activity_at = ?, ended_at = ? WHERE id = ?',
    ).run(startedAt, lastActivityAt, endedAt, id)
  }
  expect(recentSessions(reader, { sinceEpochSeconds: 100 })).toEqual({
    rows: ['ended', 'started', 'activity', 'boundary'],
    malformed: 0,
  })
  expect(recentSessions(reader, { sinceEpochSeconds: 100, maxSessions: 2 }).rows).toEqual([
    'ended',
    'started',
  ])
  expect(
    reconcileRecent(reader, { sinceEpochSeconds: 100, maxSessions: 2 }).sessions.map(
      (session) => session.roster.sessionId,
    ),
  ).toEqual(['ended', 'started'])
  expect(reconcileRecent(reader, { sinceEpochSeconds: 301 })).toEqual({
    sessions: [],
    malformed: 0,
  })
  expect(reconcileRecent(reader, { sinceEpochSeconds: 0, maxSessions: 0 })).toEqual({
    sessions: [],
    malformed: 0,
  })
})

test('recent reconciliation defaults to 50 sessions in newest order with deterministic ties', () => {
  const { db, reader } = setup()
  db.exec('DELETE FROM sessions')
  for (let index = 0; index < 55; index++) {
    const id = `session-${String(index).padStart(2, '0')}`
    insertSession(db, id)
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(
      100 + Math.floor(index / 2),
      id,
    )
  }
  const recent = reconcileRecent(reader, { sinceEpochSeconds: 100 })
  expect(recent.sessions).toHaveLength(50)
  expect(recent.sessions.slice(0, 3).map((session) => session.roster.sessionId)).toEqual([
    'session-54',
    'session-52',
    'session-53',
  ])
  expect(recent.malformed).toBe(0)
  expect(reconcileRecent(reader, { sinceEpochSeconds: 100 })).toEqual(recent)
})

test('recent reconciliation counts malformed sessions and aggregates malformed messages', () => {
  const { db, reader } = setup()
  insertSession(db, 'bad-session')
  db.exec(
    "UPDATE sessions SET last_activity_at = 3000; UPDATE sessions SET started_at = 'bad' WHERE id = 'bad-session'",
  )
  insertSessionMessage(db, { messageUid: 'message-1', toolCalls: '{bad' })
  expect(recentSessions(reader, { sinceEpochSeconds: 2500 })).toEqual({
    rows: ['session-1'],
    malformed: 1,
  })
  const result = reconcileRecent(reader, { sinceEpochSeconds: 2500 })
  expect(result.sessions).toHaveLength(1)
  expect(result.sessions[0]!.malformed).toBe(1)
  expect(result.malformed).toBe(2)
})

test('missing required columns report typed schema drift', () => {
  const { db, reader } = setup()
  db.exec('ALTER TABLE sessions DROP COLUMN ended_at')
  expect(() => recentSessions(reader, { sinceEpochSeconds: 0 })).toThrow(HermesSchemaDrift)
  db.exec('ALTER TABLE messages DROP COLUMN tool_call_uid')
  db.exec('ALTER TABLE messages RENAME COLUMN tool_call_id TO missing_tool_call_id')
  expect(() => reconcileSession(reader, { sessionId: 'session-1' })).toThrow(HermesSchemaDrift)
})

test('invalid reconciliation inputs fail validation', () => {
  const { reader } = setup()
  for (const sinceEpochSeconds of [NaN, Infinity])
    expect(() => recentSessions(reader, { sinceEpochSeconds })).toThrow(ZodError)
  for (const maxSessions of [-1, 0.5])
    expect(() => reconcileRecent(reader, { sinceEpochSeconds: 0, maxSessions })).toThrow(ZodError)
  expect(() => reconcileSession(reader, { sessionId: '' })).toThrow(ZodError)
  const roster = reconcileSession(reader, { sessionId: 'session-1' }).roster
  expect(() => revisionIdentity('', 'fixture', roster)).toThrow(ZodError)
  expect(() => revisionIdentity('builder', '', roster)).toThrow(ZodError)
})
