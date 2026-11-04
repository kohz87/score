import type { AgentSummary, AgentQuestion, Approval, Job, Room } from '@score/contract'
import { questionInRoom, questionNeedsYou } from '../../data/question-queries.ts'
import { agentDisplayName, agentStateLabel, canTalkTo } from '../bold-agents.ts'
import {
  approvalInRoom,
  approvalNeedsYou,
  isEveryoneRoom,
  jobStateLabel,
} from '../room/room-model.ts'

/** One row of the chat list: a group (a team room or another room) or a direct (one agent). */
export type ChatEntry = {
  kind: 'group' | 'direct'
  /** The room id for a group; the agent id for a direct. */
  id: string
  name: string
  /** The short second line, from data that exists today (newest job or the agent's state). */
  line: string
  unread: number
  needsYou: boolean
  /** ISO time of the newest job update; '' when nothing has happened yet. Orders the list. */
  activity: string
  room?: Room
  agent?: AgentSummary
  /** The short time of the newest activity ("09:40", "Mon", "Oct 28"); '' when there is none. */
  at: string
  /** A group's tile colour: its lead's colour. */
  color: string | null
  everyone: boolean
}

/**
 * Rooms a person talks in. A hidden run room keeps `mentions` routing (people's rooms route with exchanges), and an
 * imported session lives under Elsewhere, so neither is a chat here. Archived rooms stay out of the list.
 */
export function isChatGroup(room: Room): boolean {
  if (room.archived) return false
  if (room.role === 'team') return true
  return room.kind === 'room' && !room.importedFrom && room.routing !== 'mentions'
}

function newest(jobs: Job[]): Job | undefined {
  return [...jobs]
    .filter((job) => !job.isDefault && job.state !== 'closed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

function lastActivity(jobs: Job[]): string {
  return jobs.reduce((at, job) => (job.updatedAt > at ? job.updatedAt : at), '')
}

export function groupNeedsYou(
  room: Room,
  jobs: Job[],
  approvals: Approval[],
  questions: AgentQuestion[],
): boolean {
  return (
    jobs.some((job) => job.state === 'waiting_on_you') ||
    approvals.some((approval) => approvalNeedsYou(approval) && approvalInRoom(approval, room.id)) ||
    questions.some(
      (question) =>
        questionNeedsYou(question) && questionInRoom(question, room.id, isEveryoneRoom(room)),
    )
  )
}

/** The mock-up's small time on a row: today's clock, a weekday within the week, else the date. */
export function activityLabel(iso: string, now = new Date()): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const days = (now.getTime() - at.getTime()) / 86_400_000
  if (at.toDateString() === now.toDateString())
    return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days < 6) return at.toLocaleDateString([], { weekday: 'short' })
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function byActivity(a: ChatEntry, b: ChatEntry): number {
  return (
    b.activity.localeCompare(a.activity) ||
    Number(b.everyone) - Number(a.everyone) ||
    a.name.localeCompare(b.name)
  )
}

export type ChatLists = { groups: ChatEntry[]; directs: ChatEntry[] }

/** Both groups of the list, newest activity first, from the reads the shell already makes. */
export function buildChatLists({
  rooms,
  teamRooms,
  directRooms,
  agents,
  jobsByRoom,
  approvals,
  questions,
}: {
  rooms: Room[]
  teamRooms: Room[]
  directRooms: Room[]
  agents: AgentSummary[]
  jobsByRoom: Record<string, Job[]>
  approvals: Approval[]
  questions: AgentQuestion[]
}): ChatLists {
  const seen = new Set<string>()
  const groupRooms = [...teamRooms, ...rooms].filter((room) => {
    if (seen.has(room.id) || !isChatGroup(room)) return false
    seen.add(room.id)
    return true
  })
  const groups = groupRooms.map((room): ChatEntry => {
    const jobs = jobsByRoom[room.id] ?? []
    const job = newest(jobs)
    const lead = agents.find((agent) => agent.id === room.leadAgentId)
    return {
      kind: 'group',
      id: room.id,
      name: room.name,
      line: job
        ? `${job.title} · ${jobStateLabel(job).toLowerCase()}`
        : `${room.members.length} ${room.members.length === 1 ? 'member' : 'members'}`,
      unread: room.unread,
      needsYou: groupNeedsYou(room, jobs, approvals, questions),
      activity: lastActivity(jobs),
      at: activityLabel(lastActivity(jobs)),
      room,
      color: lead?.style.color ?? null,
      everyone: isEveryoneRoom(room),
    }
  })
  const waitingOn = new Set([
    ...approvals.filter(approvalNeedsYou).map((item) => item.agentId),
    ...questions.filter(questionNeedsYou).map((item) => item.agentId),
  ])
  const directs = agents.filter(canTalkTo).map((agent): ChatEntry => {
    const room = directRooms.find((item) => item.members.includes(agent.id))
    return {
      kind: 'direct',
      id: agent.id,
      name: agentDisplayName(agent),
      line: agent.status === 'waiting' ? 'waiting for you' : agentStateLabel(agent),
      unread: room?.unread ?? 0,
      needsYou: agent.status === 'waiting' || waitingOn.has(agent.id),
      activity: lastActivity(room ? (jobsByRoom[room.id] ?? []) : []),
      at: activityLabel(lastActivity(room ? (jobsByRoom[room.id] ?? []) : [])),
      room,
      agent,
      color: agent.style.color,
      everyone: false,
    }
  })
  return { groups: groups.sort(byActivity), directs: directs.sort(byActivity) }
}

export function filterEntries(entries: ChatEntry[], search: string): ChatEntry[] {
  const needle = search.trim().toLowerCase()
  return needle ? entries.filter((entry) => entry.name.toLowerCase().includes(needle)) : entries
}

/** The address a chat lives at today: the team room is `/b`, another room `?room=`, a direct `?with=`. */
export function chatAddress(entry: Pick<ChatEntry, 'kind' | 'id' | 'everyone'>, phone: boolean) {
  if (entry.kind === 'direct') return `/b?with=${encodeURIComponent(entry.id)}`
  if (entry.everyone) return phone ? '/b?open=1' : '/b'
  return `/b?room=${encodeURIComponent(entry.id)}`
}

/** The chat entry and job a run belongs to (a job whose recipe ref is the run), or null when no loaded job links to it. */
export function chatEntryForRun(
  lists: ChatLists,
  jobsByRoom: Record<string, Job[]>,
  runId: string,
): { entry: ChatEntry; job: Job } | null {
  for (const entry of [...lists.groups, ...lists.directs]) {
    if (!entry.room) continue
    const job = (jobsByRoom[entry.room.id] ?? []).find((item) => item.recipe?.ref === runId)
    if (job) return { entry, job }
  }
  return null
}

/** The chat and topic a run belongs to, as an address, or null when no loaded job links to it. */
export function chatForRun(
  lists: ChatLists,
  jobsByRoom: Record<string, Job[]>,
  runId: string,
): string | null {
  const found = chatEntryForRun(lists, jobsByRoom, runId)
  if (!found) return null
  const { entry, job } = found
  if (entry.kind === 'direct')
    return `/b?with=${encodeURIComponent(entry.id)}&chat=${encodeURIComponent(job.id)}`
  return entry.everyone
    ? `/b?job=${encodeURIComponent(job.id)}`
    : `/b?room=${encodeURIComponent(entry.id)}&job=${encodeURIComponent(job.id)}`
}

/** On a phone `/b` is the list; any of these says a chat (or one of its views) is open. */
const OPEN_PARAMS = [
  'with',
  'room',
  'job',
  'jobs',
  'message',
  'command',
  'open',
  'chat',
  'ref',
  'run',
  'note',
  'library',
  'work',
]
export function chatIsOpen(params: URLSearchParams): boolean {
  return OPEN_PARAMS.some((name) => params.has(name))
}

/** The current topic (the one the composer posts to): the one picked, else the newest open one, else the general conversation. */
export function currentTopic<T extends Job>(
  jobs: readonly T[],
  pickedId: string | null,
): T | undefined {
  const picked = pickedId ? jobs.find((job) => job.id === pickedId) : undefined
  const open = [...jobs]
    .filter((job) => !job.isDefault && job.state !== 'done' && job.state !== 'closed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return picked ?? open ?? jobs.find((job) => job.isDefault)
}
