import type { StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { makeJob, room } from './room-test-utils.tsx'
import {
  changeCachedJob,
  roomJobsQuery,
  roomMessagesQuery,
  teamRoomQuery,
  teamRoomsQuery,
} from './room-queries.ts'

function jobEvent(data: ReturnType<typeof makeJob>): StreamEvent {
  return {
    seq: 2,
    ts: '2026-10-24T09:10:00.000Z',
    type: 'job.upserted',
    data,
  }
}

test('a job.upserted replaces the read model instead of keeping stale unread and activity fields', () => {
  const stale = makeJob({
    id: 'job-1',
    unread: 6,
    activeAgents: ['builder'],
    summary: 'Old summary',
    lastMessageAt: '2026-10-24T09:05:00.000Z',
    messageCount: 8,
  })
  const fresh = makeJob({
    id: 'job-1',
    unread: 0,
    activeAgents: [],
    summary: 'Read just now',
    lastMessageAt: null,
    messageCount: 8,
  })

  expect(roomJobsQuery('room-1').reduce([stale], jobEvent(fresh))).toEqual([fresh])
})

test('the team-room read keeps the default job first when a job changes', () => {
  const named = makeJob({
    id: 'job-2',
    title: 'Activity feed',
    createdAt: '2026-10-24T09:02:00.000Z',
  })
  const fallback = makeJob({
    id: 'job-default',
    title: room.name,
    isDefault: true,
    createdAt: '2026-10-24T09:00:00.000Z',
  })

  const next = teamRoomQuery(null).reduce(
    { room, jobs: [named] },
    jobEvent({ ...fallback, unread: 2 }),
  )
  expect(next?.jobs.map((job) => job.id)).toEqual(['job-default', 'job-2'])
  expect(next?.jobs[0]?.unread).toBe(2)
})

test('a deleted team room clears the switcher read', () => {
  expect(
    teamRoomQuery(null).reduce(
      { room, jobs: [] },
      {
        seq: 3,
        ts: '2026-10-24T09:11:00.000Z',
        type: 'room.deleted',
        data: { id: room.id },
      },
    ),
  ).toBeNull()
})

const deleted = (id = 'job-1', roomId = 'room-1'): StreamEvent => ({
  seq: 4,
  ts: '2026-10-24T09:12:00.000Z',
  type: 'job.deleted',
  data: { id, roomId },
})

test('job.deleted drops the job from a room list and leaves another room alone', () => {
  const one = makeJob({ id: 'job-1' })
  const two = makeJob({ id: 'job-2' })
  expect(roomJobsQuery('room-1').reduce([one, two], deleted())).toEqual([two])
  expect(roomJobsQuery('room-1').reduce([one, two], deleted('job-2', 'other-room'))).toEqual([
    one,
    two,
  ])
})

test('job.deleted drops the job from the team-room read and the switcher count', () => {
  const one = makeJob({ id: 'job-1' })
  const two = makeJob({ id: 'job-2' })
  expect(teamRoomQuery(null).reduce({ room, jobs: [one, two] }, deleted())?.jobs).toEqual([two])
  expect(
    teamRoomQuery(null).reduce({ room, jobs: [one, two] }, deleted('job-1', 'other-room'))?.jobs,
  ).toEqual([one, two])
})

test('job.deleted removes the deleted job’s messages from a page that also shows other jobs', () => {
  const page = {
    items: [
      {
        id: 'message-one',
        roomId: room.id,
        jobId: 'job-1',
        author: { kind: 'you' as const },
        to: [],
        parts: [{ kind: 'text' as const, text: 'Deleted with its job.' }],
        createdAt: '2026-10-24T09:01:00.000Z',
        streaming: false,
        refs: [],
      },
      {
        id: 'message-two',
        roomId: room.id,
        jobId: 'job-2',
        author: { kind: 'you' as const },
        to: [],
        parts: [{ kind: 'text' as const, text: 'Stays.' }],
        createdAt: '2026-10-24T09:02:00.000Z',
        streaming: false,
        refs: [],
      },
    ],
    nextCursor: null,
    typing: {},
  }
  const query = roomMessagesQuery(room.id, null)
  expect(query.reduce(page, deleted('job-1', room.id)).items.map((item) => item.id)).toEqual([
    'message-two',
  ])
  expect(query.reduce(page, deleted('job-1', 'other-room'))).toBe(page)
})

test('a local delete reaches every job list without touching another room', () => {
  const queryClient = createQueryClient()
  const one = makeJob({ id: 'job-1' })
  const two = makeJob({ id: 'job-2' })
  const otherRoom = { ...room, id: 'room-2' }
  const other = makeJob({ id: 'job-other', roomId: otherRoom.id })

  queryClient.setQueryData(roomJobsQuery(room.id).key, { asOfSeq: 1, data: [one, two] })
  queryClient.setQueryData(teamRoomQuery(null).key, {
    asOfSeq: 1,
    data: { room, jobs: [one, two] },
  })
  queryClient.setQueryData(['bold-search', 'directs', 'lead'], [{ agentId: 'lead', chats: [one] }])
  queryClient.setQueryData(
    ['bold-search', 'directs', 'builder'],
    [{ agentId: 'builder', chats: [other] }],
  )
  queryClient.setQueryData(['bold', 'direct', 'lead'], {
    asOfSeq: 1,
    data: { room, chats: [one] },
  })
  queryClient.setQueryData(['bold', 'direct', 'builder'], {
    asOfSeq: 1,
    data: { room: otherRoom, chats: [other] },
  })

  changeCachedJob(queryClient, one, 'delete')

  expect(queryClient.getQueryData(roomJobsQuery(room.id).key)).toMatchObject({ data: [two] })
  expect(queryClient.getQueryData(teamRoomQuery(null).key)).toMatchObject({
    data: { jobs: [two] },
  })
  expect(queryClient.getQueryData(['bold-search', 'directs', 'lead'])).toMatchObject([
    { agentId: 'lead', chats: [] },
  ])
  expect(queryClient.getQueryData(['bold-search', 'directs', 'builder'])).toMatchObject([
    { agentId: 'builder', chats: [other] },
  ])
  expect(queryClient.getQueryData(['bold', 'direct', 'lead'])).toMatchObject({
    data: { chats: [] },
  })
  expect(queryClient.getQueryData(['bold', 'direct', 'builder'])).toMatchObject({
    data: { chats: [other] },
  })
})

test('a local delete drops the deleted job’s message pages so undo reads its thread afresh', () => {
  const queryClient = createQueryClient()
  const one = makeJob({ id: 'job-1' })
  const pageKey = roomMessagesQuery(room.id, one.id).key
  const olderPageKey = roomMessagesQuery(room.id, one.id, 'cursor-1').key
  const seekKey = ['bold', 'room-messages-seek', room.id, one.id, 'message-1'] as const
  const otherKey = roomMessagesQuery(room.id, 'job-2').key
  const page = {
    asOfSeq: 1,
    data: { asOfSeq: 1, items: [], nextCursor: null, jobId: null, typing: {} },
  }

  queryClient.setQueryData(pageKey, page)
  queryClient.setQueryData(olderPageKey, page)
  queryClient.setQueryData(seekKey, page)
  queryClient.setQueryData(otherKey, page)

  changeCachedJob(queryClient, one, 'delete')

  expect(queryClient.getQueryData(pageKey)).toBeUndefined()
  expect(queryClient.getQueryData(olderPageKey)).toBeUndefined()
  expect(queryClient.getQueryData(seekKey)).toBeUndefined()
  expect(queryClient.getQueryData(otherKey)).toEqual(page)
})

test('a local upsert puts a restored or renamed job back in the room and team reads', () => {
  const queryClient = createQueryClient()
  const renamed = makeJob({ id: 'job-1', title: 'Renamed' })

  queryClient.setQueryData(roomJobsQuery(room.id).key, { asOfSeq: 1, data: [] })
  queryClient.setQueryData(teamRoomQuery(null).key, { asOfSeq: 1, data: { room, jobs: [] } })

  changeCachedJob(queryClient, renamed, 'upsert')

  expect(queryClient.getQueryData(roomJobsQuery(room.id).key)).toMatchObject({ data: [renamed] })
  expect(queryClient.getQueryData(teamRoomQuery(null).key)).toMatchObject({
    data: { jobs: [renamed] },
  })
})

test('a chosen team’s update never replaces the first team room, and joins the team list', () => {
  const team = { ...room, id: 'team-2', name: 'Review crew', everyone: false }
  const event: StreamEvent = {
    seq: 5,
    ts: '2026-10-26T09:00:00.000Z',
    type: 'room.upserted',
    data: team,
  }
  const first = { room: { ...room, everyone: true }, jobs: [] }
  expect(teamRoomQuery(null).reduce(first, event)).toBe(first)
  const list = teamRoomsQuery.reduce([first.room], event)
  expect(list.map((item) => item.id)).toEqual([room.id, 'team-2'])
  expect(
    teamRoomsQuery.reduce(list, { ...event, type: 'room.deleted', data: { id: 'team-2' } }),
  ).toEqual([first.room])
})
