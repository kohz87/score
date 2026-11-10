import {
  RoutineScheduleSchema,
  type CreateRepeatingJob,
  type PatchRepeatingJob,
  type PinnedModel,
  type RepeatingJob,
  type Room,
} from '@score/contract'
import {
  DEFAULT_TIME,
  browserZone,
  buildSchedule,
  parseSchedule,
  type ScheduleKind,
} from './schedule-words.ts'

// Tasks › Repeating (TR.2): the new/edit panel's form, and what it sends. An edit sends only what changed.

export type Deliver = 'direct' | 'chat' | 'none'

export type RepeatingForm = {
  title: string
  prompt: string
  kind: ScheduleKind
  time: string
  day: number
  custom: string
  agentId: string
  modelMode: 'own' | 'pinned'
  pinned: PinnedModel | null
  deliver: Deliver
  roomId: string
}

/** The agent's one-to-one chat, where "its direct chat" results go; null when it has none. */
export function directRoomId(rooms: readonly Room[], directs: readonly Room[], agentId: string) {
  const direct = [...directs, ...rooms].find(
    (room) => (room.role === 'direct' || room.kind === 'direct') && room.members.includes(agentId),
  )
  return direct?.id ?? null
}

export function blankForm(agentId: string): RepeatingForm {
  return {
    title: '',
    prompt: '',
    kind: 'daily',
    time: DEFAULT_TIME,
    day: 1,
    custom: '',
    agentId,
    modelMode: 'own',
    pinned: null,
    deliver: 'direct',
    roomId: '',
  }
}

export function formOf(
  job: RepeatingJob,
  rooms: readonly Room[],
  directs: readonly Room[],
): RepeatingForm {
  const parsed = parseSchedule(job.schedule)
  const target = job.deliverTo?.roomId ?? null
  const direct = directRoomId(rooms, directs, job.agentId)
  return {
    title: job.title,
    prompt: job.description,
    kind: parsed.kind,
    time: parsed.time,
    day: parsed.day,
    custom: parsed.kind === 'custom' ? job.schedule : '',
    agentId: job.agentId,
    modelMode: job.model ? 'pinned' : 'own',
    pinned: job.model ? { model: job.model, provider: job.provider } : null,
    deliver: target === null ? 'none' : target === direct ? 'direct' : 'chat',
    roomId: target !== null && target !== direct ? target : '',
  }
}

export const scheduleOf = (form: RepeatingForm) =>
  buildSchedule(form.kind, form.time, form.day, form.custom)

export const deliverId = (form: RepeatingForm, directId: string | null) =>
  form.deliver === 'direct' ? directId : form.deliver === 'chat' ? form.roomId || null : null

/** Plain words for the first thing wrong with the form, or null. */
export function formProblem(form: RepeatingForm, directId: string | null): string | null {
  if (!form.title.trim()) return 'Give it a title first.'
  if (!form.prompt.trim()) return 'Say what it does first.'
  const schedule = scheduleOf(form)
  if (schedule === null) return 'Give the time as HH:MM, like 08:00.'
  // An agent's job is Hermes's own: it takes any single line (30m, every monday 9am, cron), so only empty or
  // multi-line text is refused here. Recipe schedules are Score's and keep the stricter ScheduleTextSchema.
  if (!RoutineScheduleSchema.safeParse(schedule).success)
    return 'Give the schedule on one line, like 0 8 * * * or every 2h.'
  if (form.modelMode === 'pinned' && !form.pinned)
    return 'Pick the model to pin, or choose Its own.'
  if (form.deliver === 'chat' && !form.roomId) return 'Pick the chat the results go to.'
  if (form.deliver === 'direct' && !directId) return 'That agent has no direct chat yet.'
  return null
}

const samePin = (a: PinnedModel | null, b: PinnedModel | null) =>
  a === b || (a !== null && b !== null && a.model === b.model && a.provider === b.provider)

/** A new job: the agent comes from the path, the zone is the browser's. */
export function createBody(form: RepeatingForm, directId: string | null): CreateRepeatingJob {
  const to = deliverId(form, directId)
  return {
    title: form.title.trim(),
    schedule: scheduleOf(form)!,
    prompt: form.prompt.trim(),
    timezone: browserZone(),
    ...(form.modelMode === 'pinned' && form.pinned ? { model: form.pinned } : {}),
    ...(to ? { deliverTo: to } : {}),
  }
}

/**
 * Only what changed since the panel opened (`before`). The job carries no zone of its own, so the zone goes with a
 * changed schedule and never alone. `directId` is the (new) agent's direct chat.
 */
export function patchBody(
  before: RepeatingForm,
  now: RepeatingForm,
  beforeTarget: string | null,
  directId: string | null,
): PatchRepeatingJob {
  const body: PatchRepeatingJob = {}
  if (now.title.trim() !== before.title.trim()) body.title = now.title.trim()
  if (now.prompt.trim() !== before.prompt.trim()) body.prompt = now.prompt.trim()
  const scheduleMoved =
    now.kind !== before.kind ||
    (now.kind === 'custom'
      ? now.custom.trim() !== before.custom.trim()
      : now.time !== before.time ||
        (now.kind === 'weekly' || now.kind === 'monthly' ? now.day !== before.day : false))
  if (scheduleMoved) {
    body.schedule = scheduleOf(now)!
    body.timezone = browserZone()
  }
  const nowPin = now.modelMode === 'pinned' ? now.pinned : null
  const beforePin = before.modelMode === 'pinned' ? before.pinned : null
  if (!samePin(nowPin, beforePin)) body.model = nowPin
  const to = deliverId(now, directId)
  if (to !== beforeTarget) body.deliverTo = to
  return body
}
