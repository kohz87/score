import type { AgentSummary, Job, KnowledgeAuthor, MessageSearchHit } from '@score/contract'

export type BoldSearchCommand = { name: string; usage: string; description: string }

export type BoldSearchAction =
  | { type: 'start-job' }
  | { type: 'add-agent' }
  | { type: 'pause' }
  | { type: 'toggle-look' }
  | { type: 'recipes' }
  | { type: 'first-run' }
  | { type: 'reset-look' }
  | { type: 'message-agent'; agentId: string }

type ResultBase = {
  id: string
  title: string
  hint: string | null
  /** The server's FTS snippet, kept raw so the UI can emphasise its `[[matched]]` words. */
  titleMarkup?: string
  hintMarkup?: string
  disabled?: boolean
}

export type BoldSearchResult =
  | (ResultBase & {
      kind: 'job'
      jobId: string
      roomName: string
      unread: number
    })
  | (ResultBase & {
      kind: 'chat'
      agentId: string
      chatId: string
    })
  | (ResultBase & {
      kind: 'note'
      path: string
    })
  | (ResultBase & {
      kind: 'message'
      jobId: string
      messageId: string
      agentId: string | null
      chatAgentId: string | null
    })
  | (ResultBase & { kind: 'action'; action: BoldSearchAction })
  | (ResultBase & { kind: 'setting'; sectionId: string })
  | (ResultBase & { kind: 'command'; name: string })

export type BoldSearchGroup = { key: string; label: string; items: BoldSearchResult[] }

export type BoldSearchNote = {
  path: string
  title: string
  lastAuthor?: KnowledgeAuthor | null
  snippet?: string
}

export type BoldSearchInput = {
  query: string
  agents: readonly AgentSummary[]
  teamJobs: readonly Job[]
  roomName: string
  directChats: readonly { agentId: string; chats: readonly Job[] }[]
  notes: readonly BoldSearchNote[]
  messages: readonly MessageSearchHit[]
  commands: readonly BoldSearchCommand[]
  paused: boolean | null
  light: boolean
  settings: readonly { id: string; title: string }[]
}

export const RESULT_LIMIT = 30

const stateLabel: Record<Job['state'], string> = {
  open: 'open',
  working: 'working',
  waiting_on_you: 'needs you',
  done: 'done',
  closed: 'closed',
}

const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'Library'

const authorOf = (author: KnowledgeAuthor | null | undefined): string | null => {
  if (!author) return null
  if (typeof author === 'string') return author
  return author.agentId
}

const noteHint = (note: BoldSearchNote): string => {
  const folder = folderOf(note.path)
  if (note.snippet !== undefined)
    return `${folder} · ${note.snippet.replaceAll('[[', '').replaceAll(']]', '')}`
  const author = authorOf(note.lastAuthor ?? null)
  return author ? `${folder} · by ${author}` : folder
}

const messageHint = (hit: MessageSearchHit, jobTitles: ReadonlyMap<string, string>): string => {
  const author = hit.author.kind === 'you' ? 'you' : hit.author.agentId
  const job = hit.jobId ? jobTitles.get(hit.jobId) : undefined
  return `${author} · ${job ?? hit.roomName}`
}

const matches = (needle: string, ...values: (string | null | undefined)[]) =>
  needle === '' || values.some((value) => value?.toLowerCase().includes(needle))

/** The grouped result list behind BoldSearch. Pure, so the prototype's order and filters stay easy to test. */
export function buildBoldSearchGroups(input: BoldSearchInput): BoldSearchGroup[] {
  const rawQuery = input.query.trim()
  const query = rawQuery.toLowerCase()
  const slash = rawQuery.startsWith('/')
  const at = rawQuery.startsWith('@')
  const term = slash || at ? rawQuery.slice(1).trim().toLowerCase() : query
  const jobTitles = new Map<string, string>()
  const chatAgentByJob = new Map<string, string>()
  for (const job of input.teamJobs) jobTitles.set(job.id, job.title)
  for (const { agentId, chats } of input.directChats)
    for (const chat of chats) {
      jobTitles.set(chat.id, chat.title)
      chatAgentByJob.set(chat.id, agentId)
    }

  if (slash) {
    const items = input.commands
      .filter((command) => matches(term, command.name, command.usage, command.description))
      .map<BoldSearchResult>((command) => ({
        kind: 'command',
        id: `command:${command.name}`,
        title: `/${command.name}`,
        hint: command.description,
        name: command.name,
      }))
    return items.length ? [{ key: 'commands', label: 'Commands', items }] : []
  }

  if (at) {
    const items = input.agents
      .filter((agent) => matches(term, agent.id, agent.name, agent.role))
      .map<BoldSearchResult>((agent) => ({
        kind: 'action',
        id: `action:message:${agent.id}`,
        title: `Message ${agent.id}`,
        hint: agent.role || null,
        action: { type: 'message-agent', agentId: agent.id },
      }))
    return items.length ? [{ key: 'do', label: 'Do something', items }] : []
  }

  const jobs: BoldSearchResult[] = input.teamJobs
    .filter((job) => matches(query, job.title))
    .map((job) => ({
      kind: 'job',
      id: `job:${job.id}`,
      title: job.title,
      hint: `${input.roomName} · ${stateLabel[job.state]}`,
      jobId: job.id,
      roomName: input.roomName,
      unread: job.unread,
    }))

  const chats: BoldSearchResult[] = input.directChats.flatMap(({ agentId, chats: list }) =>
    list
      .filter((chat) => matches(query, chat.title, chat.summary))
      .map((chat) => ({
        kind: 'chat' as const,
        id: `chat:${agentId}:${chat.id}`,
        title: chat.title,
        hint: `with ${agentId}${chat.summary ? ` · ${chat.summary}` : ''}`,
        agentId,
        chatId: chat.id,
      })),
  )

  // The server already matched and ranked notes (and messages); filtering their marked snippets again would drop
  // every multi-word hit because `[[word]]` breaks the whole-query substring.
  const notes: BoldSearchResult[] = input.notes.map((note) => ({
    kind: 'note',
    id: `note:${note.path}`,
    title: note.title,
    hint: noteHint(note),
    path: note.path,
    ...(note.snippet !== undefined
      ? { hintMarkup: `${folderOf(note.path)} · ${note.snippet}` }
      : {}),
  }))

  const messages: BoldSearchResult[] = query
    ? input.messages
        .filter(
          (hit): hit is MessageSearchHit & { jobId: string } =>
            hit.jobId !== null && hit.jobId !== undefined,
        )
        .slice(0, 4)
        .map((hit) => ({
          kind: 'message',
          id: `message:${hit.messageId}`,
          title: `“${hit.snippet.replaceAll('[[', '').replaceAll(']]', '')}”`,
          hint: messageHint(hit, jobTitles),
          jobId: hit.jobId,
          messageId: hit.messageId,
          agentId: hit.author.kind === 'agent' ? hit.author.agentId : null,
          chatAgentId: chatAgentByJob.get(hit.jobId) ?? null,
          titleMarkup: `“${hit.snippet}”`,
        }))
    : []

  const candidates: BoldSearchResult[] = [
    {
      kind: 'action',
      id: 'action:start-job',
      title: 'Start a job',
      hint: null,
      action: { type: 'start-job' },
    },
    {
      kind: 'action',
      id: 'action:add-agent',
      title: 'Add an agent',
      hint: null,
      action: { type: 'add-agent' },
    },
    {
      kind: 'action',
      id: 'action:pause',
      title: input.paused ? 'Resume everyone' : 'Pause everyone',
      hint: input.paused === null ? "Couldn't read whether the team is paused" : null,
      disabled: input.paused === null,
      action: { type: 'pause' },
    },
    {
      kind: 'action',
      id: 'action:look',
      title: `Switch to ${input.light ? 'dark' : 'light'}`,
      hint: 'for this visit',
      action: { type: 'toggle-look' },
    },
    {
      kind: 'action',
      id: 'action:recipes',
      title: 'Edit recipes',
      hint: null,
      action: { type: 'recipes' },
    },
    {
      kind: 'action',
      id: 'action:first-run',
      title: 'Show first run',
      hint: null,
      action: { type: 'first-run' },
    },
    {
      kind: 'action',
      id: 'action:reset-look',
      title: 'Reset look on this device',
      hint: null,
      action: { type: 'reset-look' },
    },
    ...input.agents.map<BoldSearchResult>((agent) => ({
      kind: 'action',
      id: `action:message:${agent.id}`,
      title: `Message ${agent.id}`,
      hint: null,
      action: { type: 'message-agent', agentId: agent.id },
    })),
    ...input.settings.map<BoldSearchResult>((section) => ({
      kind: 'setting',
      id: `setting:${section.id}`,
      title: `Settings: ${section.title}`,
      hint: null,
      sectionId: section.id,
    })),
  ]
  const actions = candidates.filter((result) => matches(query, result.title))

  const groups: BoldSearchGroup[] = [
    { key: 'jobs', label: 'Jobs', items: jobs },
    { key: 'chats', label: 'One-to-one chats', items: chats },
    { key: 'notes', label: 'Library', items: notes },
    { key: 'messages', label: 'Messages', items: messages },
    { key: 'do', label: 'Do something', items: actions },
  ].filter((group) => group.items.length > 0)

  const remaining = RESULT_LIMIT
  const limited: BoldSearchGroup[] = []
  let left = remaining
  for (const group of groups) {
    if (left <= 0) break
    const items = group.items.slice(0, left)
    if (items.length) limited.push({ ...group, items })
    left -= items.length
  }
  return limited
}

export const flattenBoldSearch = (groups: readonly BoldSearchGroup[]): BoldSearchResult[] =>
  groups.flatMap((group) => group.items)

/** Arrow keys wrap the selection, like a menu. */
export function nextBoldSearchIndex(index: number, direction: 1 | -1, count: number): number {
  if (count <= 0) return -1
  if (index < 0) return direction === 1 ? 0 : count - 1
  return (index + direction + count) % count
}
