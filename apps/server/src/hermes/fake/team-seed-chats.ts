import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { createJob, updateJob } from '../../domain/exchanges/store.ts'
import { insertRoom } from '../../domain/rooms.ts'
import { iso, markJobRead, minutes, storeText } from './team-seed-helpers.ts'

export interface SeedDirectChats {
  websockets: { jobId: string }
  cursor: { answerMessageId: string }
}

function directRoom(
  sqlite: DatabaseSync,
  agentId: string,
  at: string,
): { roomId: string; roomName: string } {
  const existing = sqlite
    .prepare("SELECT id, name FROM rooms WHERE kind = 'direct' AND lead_agent_id = ?")
    .get(agentId) as { id: string; name: string } | undefined
  if (existing) return { roomId: existing.id, roomName: existing.name }
  const roomId = randomUUID()
  const roomName = agentId
  insertRoom(
    sqlite,
    { id: roomId, name: roomName, kind: 'direct', leadAgentId: agentId, members: [agentId] },
    at,
  )
  return { roomId, roomName }
}

function chat(
  sqlite: DatabaseSync,
  room: { roomId: string },
  title: string,
  personText: string,
  agentId: string,
  agentText: string,
  at: string,
  id: string,
): { jobId: string; personMessageId: string; answerMessageId: string } {
  // The seed predates the one-job rule (3.28.0): its rooms keep several open topics, the legacy path.
  const { job } = createJob(
    sqlite,
    room.roomId,
    title,
    iso(Date.parse(at) - 120_000),
    {},
    { allowBusy: true },
  )
  const personMessageId = `seed_${id}_you`
  const answerMessageId = `seed_${id}_agent`
  storeText(sqlite, {
    id: personMessageId,
    roomId: room.roomId,
    jobId: job.id,
    author: { kind: 'you' },
    text: personText,
    at: iso(Date.parse(at) - 60_000),
  })
  storeText(sqlite, {
    id: answerMessageId,
    roomId: room.roomId,
    jobId: job.id,
    author: { kind: 'agent', agentId },
    text: agentText,
    at,
  })
  markJobRead(sqlite, job.id)
  return { jobId: job.id, personMessageId, answerMessageId }
}

export function seedDirectChats(sqlite: DatabaseSync, nowMs: number): SeedDirectChats {
  const at = minutes(nowMs, 4 * 24 * 60)
  const builder = directRoom(sqlite, 'builder', at)
  const reviewer = directRoom(sqlite, 'reviewer', at)

  // The room's default job is the classic shell's DM thread; the new shell's chats are separate jobs. Close it so the
  // classic DM stays empty and `GET /api/agents/:id/direct` lists exactly the chats below.
  const builderDefault = sqlite
    .prepare('SELECT id, state FROM jobs WHERE room_id = ? AND is_default = 1')
    .get(builder.roomId) as { id: string; state: string }
  if (builderDefault.state !== 'closed')
    updateJob(sqlite, builderDefault.id, { state: 'closed' }, at)
  const reviewerDefault = sqlite
    .prepare('SELECT id, state FROM jobs WHERE room_id = ? AND is_default = 1')
    .get(reviewer.roomId) as { id: string; state: string }
  if (reviewerDefault.state !== 'closed')
    updateJob(sqlite, reviewerDefault.id, { state: 'closed' }, at)

  const websockets = chat(
    sqlite,
    builder,
    'Websockets or server-sent events',
    'Why websockets and not server-sent events?',
    'builder',
    'Server-sent events only go one way. We’ll want to pause and resume the feed from the browser later, and a socket does both over one connection.',
    minutes(nowMs, 120),
    'dm_websockets',
  )
  const cursor = chat(
    sqlite,
    builder,
    'The cursor bug',
    'Why did reviewer send the read layer back?',
    'builder',
    'Using created_at alone, two events written in the same millisecond collide and one is skipped. I switched the cursor to (created_at, id) and added a test.',
    minutes(nowMs, 3 * 24 * 60),
    'dm_cursor',
  )
  chat(
    sqlite,
    builder,
    'Working in the Docker sandbox',
    'Can you work inside the Docker sandbox from now on?',
    'builder',
    'Done. My commands now run in the container, so your own machine is untouched.',
    minutes(nowMs, 10 * 24 * 60),
    'dm_sandbox',
  )
  chat(
    sqlite,
    reviewer,
    'How strict to be on docs',
    'How strict should you be on docs?',
    'reviewer',
    'I’ll block only when steps are missing or wrong, and suggest the rest.',
    minutes(nowMs, 8 * 24 * 60),
    'dm_docs',
  )
  return { websockets, cursor }
}
