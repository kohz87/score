import type { DatabaseSync } from 'node:sqlite'
import { pinMessage } from '../../domain/exchanges/sharing.ts'
import { createJob, updateJob } from '../../domain/exchanges/store.ts'
import { reserveMessageRun } from '../../domain/message-runs.ts'
import { storeMessage } from '../../domain/rooms.ts'
import { AGENTS, markJobRead, minutes, playTurn, storeText } from './team-seed-helpers.ts'

export function seedReleaseNotes(sqlite: DatabaseSync, roomId: string, nowMs: number): string {
  const { job } = createJob(
    sqlite,
    roomId,
    'Release notes 2.4',
    minutes(nowMs, 120),
    {},
    {
      allowBusy: true,
    },
  )
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

export function seedQueueResearch(sqlite: DatabaseSync, roomId: string, nowMs: number): string {
  const { job } = createJob(
    sqlite,
    roomId,
    'Queue research',
    minutes(nowMs, 60),
    {},
    {
      allowBusy: true,
    },
  )
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

export function seedPinnedDecision(
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
