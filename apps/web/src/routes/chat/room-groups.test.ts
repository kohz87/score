import type { Room, RoomProject } from '@score/contract'
import { expect, test } from 'vitest'
import { baseName, groupRooms } from './room-groups.ts'
import { roomLabel } from './room-label.ts'

const base: Room = {
  id: 'r',
  name: '#a',
  kind: 'room',
  leadAgentId: null,
  members: [],
  unread: 0,
  activeAgents: [],
  channels: [],
}
const room = (id: string, patch: Partial<Room> = {}): Room => ({
  ...base,
  id,
  name: `#${id}`,
  ...patch,
})
const launch: RoomProject = { id: 'p1', name: 'Launch', color: '#6B4EFF' }
const empty: RoomProject = { id: 'p2', name: 'Empty', color: '#19C39A' }

test('pinned rooms come first, projects group the rest, archived rooms are hidden', () => {
  const rooms = [
    room('zeta'),
    room('beta', { projectId: 'p1' }),
    room('alpha', { pinned: true, projectId: 'p1' }),
    room('old', { archived: true }),
    room('gone', { projectId: 'deleted-project' }),
  ]
  const groups = groupRooms(rooms, [launch, empty], { showArchived: false, tag: null })
  expect(groups.pinned.map((item) => item.id)).toEqual(['alpha'])
  expect(groups.projects.map((group) => [group.project.id, group.rooms.map((r) => r.id)])).toEqual([
    ['p1', ['beta']],
    ['p2', []],
  ])
  // A room whose project no longer exists falls back to the plain list.
  expect(groups.rest.map((item) => item.id)).toEqual(['gone', 'zeta'])
  expect(groups.archivedHidden).toBe(1)
  const all = groupRooms(rooms, [launch], { showArchived: true, tag: null })
  expect(all.rest.map((item) => item.id)).toContain('old')
  expect(all.archivedHidden).toBe(0)
})

test('a tag filter narrows every group and the tag list ignores hidden archived rooms', () => {
  const rooms = [
    room('a', { tags: ['q4'] }),
    room('b', { tags: ['q4', 'urgent'], projectId: 'p1' }),
    room('c', { tags: ['other'], archived: true }),
    room('d'),
  ]
  const groups = groupRooms(rooms, [launch, empty], { showArchived: false, tag: 'q4' })
  expect(groups.tags).toEqual(['q4', 'urgent'])
  expect(groups.rest.map((item) => item.id)).toEqual(['a'])
  expect(groups.projects.map((group) => group.project.id)).toEqual(['p1'])
})

test('room labels drop the tag words', () => {
  expect(baseName('#launch #q4')).toBe('#launch')
  expect(roomLabel(room('x', { name: 'launch #q4' }))).toBe('#launch')
  expect(roomLabel({ ...room('d'), kind: 'direct', name: 'Lead' })).toBe('Lead')
})
