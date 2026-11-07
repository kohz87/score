import type { DatabaseSync } from 'node:sqlite'
import { insertApproval } from '../../domain/approvals.ts'
import { freezeRef, shareMessage } from '../../domain/exchanges/sharing.ts'
import { createJob, updateJob } from '../../domain/exchanges/store.ts'
import { unifiedDiff } from '../../domain/line-diff.ts'
import { approvalMessage, reserveMessageRun } from '../../domain/message-runs.ts'
import { storeMessage, updateMessage } from '../../domain/rooms.ts'
import { recordFrame } from '../../domain/watch-frames.ts'
import type { SeedDirectChats } from './team-seed-chats.ts'
import {
  AGENTS,
  markJobRead,
  minutes,
  pendingTurn,
  playTurn,
  startTurn,
  storeText,
} from './team-seed-helpers.ts'

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

export function seedActivityFeed(
  sqlite: DatabaseSync,
  roomId: string,
  nowMs: number,
  direct: SeedDirectChats,
): string {
  const { job } = createJob(
    sqlite,
    roomId,
    'Activity feed',
    minutes(nowMs, 180),
    {},
    {
      allowBusy: true,
    },
  )
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
