import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ExchangeAction } from '@score/contract'
import { insertApproval } from '../../domain/approvals.ts'
import { stageAction, turnForCapability } from '../../domain/exchanges/actions.ts'
import { hashXtc, mintXtc } from '../../domain/exchanges/capability.ts'
import { freezeRef, pinMessage, shareMessage } from '../../domain/exchanges/sharing.ts'
import { createJob, jobRow, updateJob } from '../../domain/exchanges/store.ts'
import {
  approvalMessage,
  attachRunMessage,
  completeRunMessage,
  reserveMessageRun,
} from '../../domain/message-runs.ts'
import { insertRoom, storeMessage, updateMessage } from '../../domain/rooms.ts'
import { teamRoomId } from '../../domain/team-room.ts'
import { unifiedDiff } from '../../domain/line-diff.ts'
import { recordFrame } from '../../domain/watch-frames.ts'

// The fake adapter's demo team room (PLAN 11.2c). Every board state the bold-shell UI tasks need is real data in
// Score's own tables: jobs, messages, exchanges, actions, pauses, watch frames, approvals, one-to-one chats, references,
// shares and pins. The rows are made with the same domain functions real turns use so their reads stay in step.
//
// Times are minutes before `nowMs`, so the relative labels in the prototype hold ("just now", "2 min").

const AGENTS = ['lead', 'builder', 'reviewer', 'designer'] as const

interface Turn {
  turnId: string
  runId: string
  agentId: string
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function minutes(nowMs: number, ago: number): string {
  return iso(nowMs - ago * 60_000)
}

function storeText(
  sqlite: DatabaseSync,
  message: {
    id: string
    roomId: string
    jobId: string
    author: { kind: 'you' } | { kind: 'agent'; agentId: string }
    text: string
    at: string
    to?: string[]
  },
): void {
  storeMessage(
    sqlite,
    {
      id: message.id,
      roomId: message.roomId,
      author: message.author,
      to: message.to ?? [],
      parts: [{ kind: 'text', text: message.text }],
      createdAt: message.at,
      streaming: false,
      refs: [],
      jobId: message.jobId,
    },
    message.at,
  )
}

/** Marks a job read up to its newest message. There is no job-scoped counterpart of `markRoomRead`. */
function markJobRead(sqlite: DatabaseSync, jobId: string): void {
  const newest = sqlite
    .prepare(
      'SELECT id, created_at FROM messages WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get(jobId) as { id: string; created_at: string } | undefined
  if (!newest) return
  sqlite
    .prepare(
      `INSERT INTO job_reads (job_id, last_read_message_created_at, last_read_message_id)
       VALUES (?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET
         last_read_message_created_at = excluded.last_read_message_created_at,
         last_read_message_id = excluded.last_read_message_id
       WHERE (excluded.last_read_message_created_at, excluded.last_read_message_id) >
             (job_reads.last_read_message_created_at, job_reads.last_read_message_id)`,
    )
    .run(jobId, newest.created_at, newest.id)
}

function pendingTurn(sqlite: DatabaseSync, jobId: string, agentId: string): string {
  const row = sqlite
    .prepare(
      "SELECT turn_id FROM message_runs WHERE job_id = ? AND agent_id = ? AND state = 'pending' ORDER BY created_at, rowid LIMIT 1",
    )
    .get(jobId, agentId) as { turn_id: string } | undefined
  if (!row) throw new Error(`seedFakeTeam: no pending turn for ${agentId} in ${jobId}`)
  return row.turn_id
}

function startTurn(
  sqlite: DatabaseSync,
  turnId: string,
  agentId: string,
  runId: string,
  at: string,
  status = 'running',
): string {
  const capability = mintXtc()
  sqlite
    .prepare('UPDATE message_runs SET xtc_hash = ? WHERE turn_id = ?')
    .run(hashXtc(capability), turnId)
  sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at, cost_usd) VALUES (?, ?, 'score', ?, ?, ?, 0)",
    )
    .run(runId, agentId, status, at, at)
  attachRunMessage(sqlite, turnId, runId, at)
  return capability
}

function act(
  sqlite: DatabaseSync,
  turn: Turn,
  capability: string,
  commandId: string,
  action: ExchangeAction,
  at: string,
): void {
  const found = turnForCapability(sqlite, capability, turn.agentId)
  if (!found) throw new Error(`seedFakeTeam: capability refused for ${turn.agentId}`)
  const receipt = stageAction(sqlite, { turn: found, commandId, action, channel: 'bridge' }, at)
  if (receipt.status === 'refused')
    throw new Error(`seedFakeTeam: ${action.action} refused: ${receipt.message}`)
}

function finishTurn(sqlite: DatabaseSync, turn: Turn, at: string, output: string): void {
  sqlite
    .prepare("UPDATE runs SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?")
    .run(at, at, turn.runId)
  completeRunMessage(sqlite, turn.runId, at, { output, status: 'completed', reply: output })
}

const FEED_FILE = 'api/events.py'
const FEED_V1 = [
  'PAGE_SIZE = 50',
  '',
  '',
  'def page(after):',
  '    rows = db.events.where(created_at__gt=after).order_by("created_at")',
  '    return rows[:PAGE_SIZE]',
  '',
  '',
  'def newest():',
  '    return page(after=None)',
  '',
].join('\n')
const FEED_V2 = [
  'PAGE_SIZE = 50',
  '',
  '',
  'def page(after):',
  '    # (created_at, id): two events in the same millisecond both come through.',
  '    rows = db.events.where(cursor__gt=after).order_by("created_at", "id")',
  '    return rows[:PAGE_SIZE]',
  '',
  '',
  'def newest():',
  '    return page(after=None)',
  '',
].join('\n')

function feedEdit(
  sqlite: DatabaseSync,
  runId: string,
  seq: number,
  at: string,
  before: string,
  after: string,
) {
  recordFrame(sqlite, {
    agentId: 'builder',
    runId,
    at,
    callKey: `seed:feed:edit:${seq}`,
    surface: 'editor',
    payload: { path: FEED_FILE, diff: unifiedDiff(before, after), language: 'python' },
    caption: `Edited ${FEED_FILE}`,
  })
}

function playTurn(
  sqlite: DatabaseSync,
  jobId: string,
  agentId: string,
  runId: string,
  at: string,
  action: ExchangeAction | undefined,
  output: string,
  commandId: string,
): Turn {
  const turnId = pendingTurn(sqlite, jobId, agentId)
  const turn = { turnId, runId, agentId }
  const capability = startTurn(sqlite, turnId, agentId, runId, at)
  if (action) act(sqlite, turn, capability, commandId, action, at)
  finishTurn(sqlite, turn, at, output)
  return turn
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
  const { job } = createJob(sqlite, room.roomId, title, iso(Date.parse(at) - 120_000))
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

function seedDirectChats(
  sqlite: DatabaseSync,
  nowMs: number,
): { websockets: { jobId: string }; cursor: { answerMessageId: string } } {
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

function seedActivityFeed(
  sqlite: DatabaseSync,
  roomId: string,
  nowMs: number,
  direct: { websockets: { jobId: string }; cursor: { answerMessageId: string } },
): string {
  const { job } = createJob(sqlite, roomId, 'Activity feed', minutes(nowMs, 180))
  const requestId = 'seed_feed_request'
  storeText(sqlite, {
    id: requestId,
    roomId,
    jobId: job.id,
    author: { kind: 'you' },
    text: 'Get the activity feed streaming to the browser. Have it reviewed.',
    at: minutes(nowMs, 50),
  })
  reserveMessageRun(
    sqlite,
    {
      parentMessageId: requestId,
      roomId,
      agentId: 'builder',
      chainId: requestId,
      hop: 0,
      input: 'Get the activity feed streaming to the browser. Have it reviewed.',
      agents: [...AGENTS],
      retryNonce: 'seed:feed',
    },
    minutes(nowMs, 49),
  )
  // The addressed agent becomes the job's holder (the person asked builder).
  updateJob(sqlite, job.id, { holder: 'builder' }, minutes(nowMs, 49))

  playTurn(
    sqlite,
    job.id,
    'builder',
    'seed_run_feed_1',
    minutes(nowMs, 49),
    { action: 'review', to: 'reviewer', note: 'Read layer is ready. Can you review it?' },
    'Read layer is ready. Can you review it?',
    'seed-feed-1',
  )
  // The Workbench (11.6a): builder wrote the read layer, the reviewer's note lands on the cursor line the fix rewrites.
  feedEdit(sqlite, 'seed_run_feed_1', 1, minutes(nowMs, 49), '', FEED_V1)
  playTurn(
    sqlite,
    job.id,
    'reviewer',
    'seed_run_feed_2',
    minutes(nowMs, 47),
    {
      action: 'send_back',
      note: 'Events in the same millisecond get skipped.\nFix the cursor?',
      comments: [
        { path: FEED_FILE, line: 5, text: 'Two events in one millisecond: the second is skipped.' },
      ],
    },
    'Sent back: events in the same millisecond get skipped. Fix the cursor?',
    'seed-feed-2',
  )
  playTurn(
    sqlite,
    job.id,
    'builder',
    'seed_run_feed_3',
    minutes(nowMs, 45),
    { action: 'review', to: 'reviewer', note: 'Cursor is now (created_at, id), with a test.' },
    'Cursor is now (created_at, id), with a test.',
    'seed-feed-3',
  )
  feedEdit(sqlite, 'seed_run_feed_3', 2, minutes(nowMs, 45), FEED_V1, FEED_V2)
  playTurn(
    sqlite,
    job.id,
    'reviewer',
    'seed_run_feed_4',
    minutes(nowMs, 43),
    {
      action: 'approve',
      note: 'Looks right.',
      comments: [{ path: FEED_FILE, line: 7, text: 'Nice: the page size is one constant.' }],
    },
    'Approved. Looks right.',
    'seed-feed-4',
  )

  // The approved turn leaves builder one turn to finish. Keep it running while it waits for the package approval, so
  // the result's preview and screen frames read live and builder shows as busy in this job.
  const finishTurnId = pendingTurn(sqlite, job.id, 'builder')
  const approvalRun = 'seed_run_feed_approval'
  startTurn(sqlite, finishTurnId, 'builder', approvalRun, minutes(nowMs, 41))
  updateMessage(
    sqlite,
    roomId,
    `reply:${finishTurnId}`,
    'Waiting for your OK to install ws@8.',
    minutes(nowMs, 40),
  )
  sqlite
    .prepare("UPDATE runs SET status = 'waiting_for_approval', updated_at = ? WHERE id = ?")
    .run(minutes(nowMs, 3), approvalRun)

  const approvalId = insertApproval(sqlite, {
    origin: 'score-run',
    stage: 'human',
    target_kind: 'run_request',
    visible: 1,
    profile: 'builder',
    session_key: approvalRun,
    run_id: approvalRun,
    request_id: 'seed-package-approval',
    description: 'May I install a package?\nnpm install ws@8 is needed for the websocket feed.',
    command: 'npm install ws@8',
    created_at: minutes(nowMs, 2),
    blocking: 'Only this command is waiting; the rest of the team can continue.',
  })
  approvalMessage(sqlite, approvalId, minutes(nowMs, 2))

  recordFrame(sqlite, {
    agentId: 'builder',
    runId: approvalRun,
    at: minutes(nowMs, 2),
    callKey: 'seed:feed:terminal',
    surface: 'terminal',
    payload: {
      cwd: '~/app',
      command: 'pnpm test api/events',
      output:
        'ok  pages newest first\nok  keeps same-millisecond events\nwaiting  for your OK to install ws@8',
      status: 'running',
    },
    caption: 'Ran pnpm test api/events',
  })
  recordFrame(sqlite, {
    agentId: 'builder',
    runId: approvalRun,
    at: minutes(nowMs, 3),
    callKey: 'seed:feed:browser',
    surface: 'browser',
    payload: {
      url: 'http://localhost:5173/feed',
      title: 'Activity feed',
      imageUrl: null,
    },
    caption: 'Opened the activity feed',
  })

  // Two rounds of changed files, so the Results change card adds both paths and keeps the reviewer's catch.
  storeMessage(
    sqlite,
    {
      id: 'seed_feed_files_1',
      roomId,
      author: { kind: 'agent', agentId: 'builder' },
      to: [],
      parts: [
        { kind: 'file', path: 'api/events.py', added: 12, removed: 2 },
        { kind: 'text', text: 'The read layer is in.' },
      ],
      createdAt: minutes(nowMs, 48),
      streaming: false,
      refs: [],
      jobId: job.id,
    },
    minutes(nowMs, 48),
  )
  storeMessage(
    sqlite,
    {
      id: 'seed_feed_files_2',
      roomId,
      author: { kind: 'agent', agentId: 'builder' },
      to: [],
      parts: [
        { kind: 'file', path: 'api/events.py', added: 3, removed: 1 },
        { kind: 'file', path: 'api/test_events.py', added: 20, removed: 0 },
        { kind: 'text', text: 'Cursor fixed, with a test.' },
      ],
      createdAt: minutes(nowMs, 44),
      streaming: false,
      refs: [],
      jobId: job.id,
    },
    minutes(nowMs, 44),
  )
  storeText(sqlite, {
    id: 'seed_feed_done',
    roomId,
    jobId: job.id,
    author: { kind: 'agent', agentId: 'lead' },
    text: 'Done. Here it is.',
    at: minutes(nowMs, 39),
  })

  // A one-to-one chat quoted into this job (a frozen summary, not its transcript).
  const ref = freezeRef(sqlite, direct.websockets.jobId, minutes(nowMs, 30))
  storeMessage(
    sqlite,
    {
      id: 'seed_feed_ref',
      roomId,
      author: { kind: 'you' },
      to: ['lead'],
      parts: [{ kind: 'text', text: 'Switch it to websockets.' }, ref],
      createdAt: minutes(nowMs, 30),
      streaming: false,
      refs: [],
      jobId: job.id,
    },
    minutes(nowMs, 30),
  )
  // One message shared from a one-to-one into this job (a frozen copy).
  shareMessage(sqlite, direct.cursor.answerMessageId, job.id, minutes(nowMs, 25))

  updateJob(sqlite, job.id, { holder: 'builder', state: 'working' }, minutes(nowMs, 1))
  markJobRead(sqlite, job.id)
  return job.id
}

function seedReleaseNotes(sqlite: DatabaseSync, roomId: string, nowMs: number): string {
  const { job } = createJob(sqlite, roomId, 'Release notes 2.4', minutes(nowMs, 120))
  const requestId = 'seed_notes_request'
  storeText(sqlite, {
    id: requestId,
    roomId,
    jobId: job.id,
    author: { kind: 'you' },
    text: 'Draft the 2.4 release notes and an announcement image.',
    at: minutes(nowMs, 90),
  })
  reserveMessageRun(
    sqlite,
    {
      parentMessageId: requestId,
      roomId,
      agentId: 'lead',
      chainId: requestId,
      hop: 0,
      input: 'Draft the 2.4 release notes and an announcement image.',
      agents: [...AGENTS],
      retryNonce: 'seed:notes',
    },
    minutes(nowMs, 89),
  )
  updateJob(sqlite, job.id, { holder: 'lead' }, minutes(nowMs, 89))

  const leadNotes = [
    'Draft is ready.',
    'Added a short note; full steps take a day.',
    'I’d ship now and write full steps for 2.4.1.',
    'The draft now names the migration in the release notes.',
    'I think the draft is ready to ship.',
  ]
  const reviewNotes = [
    'Missing migration steps for 2.3 users.',
    'A short note isn’t enough for a breaking change.',
    'Still missing the upgrade path.',
    'The draft still needs its migration steps.',
  ]
  let turnNumber = 0
  let minute = 80
  // The first lead review is the person-started turn that opens the exchange, so it does not count against the
  // exchange's budget. Four send-backs and four more reviews make 8 exchange turns; the final review's queued
  // reviewer turn is then held at 8 of 8.
  for (let round = 0; round < leadNotes.length; round += 1) {
    turnNumber += 1
    playTurn(
      sqlite,
      job.id,
      'lead',
      `seed_run_notes_${turnNumber}`,
      minutes(nowMs, minute),
      { action: 'review', to: 'reviewer', note: leadNotes[round]! },
      leadNotes[round]!,
      `seed-notes-${turnNumber}`,
    )
    minute -= 2
    if (round === leadNotes.length - 1) break
    turnNumber += 1
    playTurn(
      sqlite,
      job.id,
      'reviewer',
      `seed_run_notes_${turnNumber}`,
      minutes(nowMs, minute),
      { action: 'send_back', note: reviewNotes[round]! },
      `Sent back: ${reviewNotes[round]!}`,
      `seed-notes-${turnNumber}`,
    )
    minute -= 2
  }
  storeMessage(
    sqlite,
    {
      id: 'seed_notes_draft',
      roomId,
      author: { kind: 'agent', agentId: 'designer' },
      to: [],
      parts: [
        {
          kind: 'document',
          mediaId: 'seed_notes_announcement',
          name: 'Announcement image.md',
          contentType: 'text/markdown',
          size: 512,
        },
        { kind: 'text', text: 'A first pass at the announcement image.' },
      ],
      createdAt: minutes(nowMs, 10),
      streaming: false,
      refs: [],
      jobId: job.id,
    },
    minutes(nowMs, 10),
  )
  return job.id
}

function seedQueueResearch(sqlite: DatabaseSync, roomId: string, nowMs: number): string {
  const { job } = createJob(sqlite, roomId, 'Queue research', minutes(nowMs, 60))
  storeText(sqlite, {
    id: 'seed_queue_request',
    roomId,
    jobId: job.id,
    author: { kind: 'you' },
    text: 'Compare three queue libraries.',
    at: minutes(nowMs, 55),
  })
  storeText(sqlite, {
    id: 'seed_queue_summary',
    roomId,
    jobId: job.id,
    author: { kind: 'agent', agentId: 'lead' },
    text: 'Queue libraries compared. One clear pick, with sources and licence notes.',
    at: minutes(nowMs, 54),
  })
  updateJob(sqlite, job.id, { state: 'done' }, minutes(nowMs, 54))
  markJobRead(sqlite, job.id)
  return job.id
}

function seedPinnedDecision(
  sqlite: DatabaseSync,
  roomId: string,
  defaultJob: string,
  nowMs: number,
): void {
  const messageId = 'seed_pinned_decision'
  storeText(sqlite, {
    id: messageId,
    roomId,
    jobId: defaultJob,
    author: { kind: 'agent', agentId: 'reviewer' },
    text: 'Event cursors are (created_at, id)',
    at: minutes(nowMs, 23),
  })
  pinMessage(sqlite, roomId, messageId, minutes(nowMs, 22))
  markJobRead(sqlite, defaultJob)
}

/** Seeds the demo team room once; a second start finds the jobs and changes nothing. */
export function seedFakeTeam(sqlite: DatabaseSync, nowMs = Date.now()): void {
  const roomId = teamRoomId(sqlite)
  if (!roomId) throw new Error('seedFakeTeam: the team room must exist first')
  // A deterministic row from the seed is the marker: a second start (or a user's own "Activity feed" job) is untouched.
  if (sqlite.prepare("SELECT 1 FROM messages WHERE id = 'seed_feed_request'").get()) return

  // Members are kept by ensureTeamRoom; the person picks the lead, and demo data picks `lead` for them.
  sqlite
    .prepare(
      'UPDATE rooms SET lead_agent_id = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    )
    .run('lead', minutes(nowMs, 240), roomId)
  // ensureTeamRoom made the room's default job. Team room jobs list the four demo threads; the pinned decision lives
  // in this first one.
  const defaultJob = sqlite
    .prepare('SELECT id FROM jobs WHERE room_id = ? AND is_default = 1')
    .get(roomId) as { id: string }
  if (!jobRow(sqlite, defaultJob.id))
    throw new Error('seedFakeTeam: the team room has no default job')

  const direct = seedDirectChats(sqlite, nowMs)
  seedPinnedDecision(sqlite, roomId, defaultJob.id, nowMs)
  seedActivityFeed(sqlite, roomId, nowMs, direct)
  seedReleaseNotes(sqlite, roomId, nowMs)
  seedQueueResearch(sqlite, roomId, nowMs)
}
