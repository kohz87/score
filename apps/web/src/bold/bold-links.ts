/**
 * Every destination inside the bold shell. The query parameters are read by later tasks:
 * `job`/`message` by the room (11.4), `with`/`chat` by one-to-ones (11.7), `note` by Library (11.10e),
 * `start` by Start a job (11.10c), `recipes` by the recipe editor (11.10d), `first` by first run (11.10b),
 * `add` by Add an agent (11.8c), and `command` by the composer's slash-command hand-off (11.4a).
 */

function boldQuery(values: Record<string, string>): string {
  return `/b?${new URLSearchParams(values).toString()}`
}

/** 11.4 room: open a team-room job. */
export function boldJobLink(jobId: string): string {
  return boldQuery({ job: jobId })
}

/** 11.4 room: open a team-room message at its job. */
export function boldMessageLink(jobId: string, messageId: string): string {
  return boldQuery({ job: jobId, message: messageId })
}

/** 11.7 one-to-ones: open an agent's chat. */
export function boldChatLink(agentId: string, chatId: string): string {
  return boldQuery({ with: agentId, chat: chatId })
}

/** 11.7 "Take it aside": a new one-to-one whose first message refers to the team-room job. */
export function boldChatRefLink(agentId: string, chatId: string, jobId: string): string {
  return boldQuery({ with: agentId, chat: chatId, ref: jobId })
}

/** 11.7 "Take it aside" / "Bring into a new chat": an empty new chat that refers to a job; it is made on first send. */
export function boldAsideLink(agentId: string, jobId: string): string {
  return boldQuery({ with: agentId, ref: jobId })
}

/** 11.7 one-to-ones: open an agent's home, keeping the room's job and any other unrelated parameters. */
export function boldOneToOneLink(agentId: string, search = ''): string {
  const params = new URLSearchParams(search)
  params.set('with', agentId)
  params.delete('chat')
  params.delete('ref')
  return `/b?${params.toString()}`
}

/** 11.12b search: a repeating job lives in the agent's Team page, under More › Routines. */
export function boldAgentRoutinesLink(agentId: string): string {
  return `/b/team/${encodeURIComponent(agentId)}#agent-routines`
}

/** 11.10e Library: open a note. */
export function boldNoteLink(path: string): string {
  return boldQuery({ note: path })
}

/** 2.5.0 Runs: open a run (by its brief id) in the side panel's Runs view. */
export function boldRunLink(briefId: string): string {
  return boldQuery({ run: briefId })
}

/** 11.10c Start a job: open its dialog. */
export function boldStartJobLink(): string {
  return boldQuery({ start: 'job' })
}

/** 11.10d Recipe editor: open it. */
export function boldRecipesLink(): string {
  return boldQuery({ recipes: '1' })
}

/** Closing Recipes keeps the room, job, message, Workbench tab and file the person was looking at. */
export function boldCloseRecipesLink(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('recipes')
  return params.size > 0 ? `/b?${params.toString()}` : '/b'
}

/** 11.10b First run: replay it. */
export function boldFirstRunLink(): string {
  return boldQuery({ first: 'run' })
}

/** 11.4a composer: load a slash command. */
export function boldCommandLink(name: string): string {
  return boldQuery({ command: name })
}

/** 11.8c Add an agent: open the team page's add flow. */
export function boldAddAgentLink(): string {
  return '/b/team?add=agent'
}

export function boldSettingsSectionLink(sectionId: string): string {
  return `/b/settings/${encodeURIComponent(sectionId)}`
}

/** The Workbench tabs a Results card links to (11.5); the Workbench screen itself reads `work` in 11.6b. */
export type WorkbenchTab = 'code' | 'screen' | 'draft' | 'workbench'

/** 11.6b Workbench: a job's Workbench at the tab a Results card chose, optionally on one file. */
export function workbenchHref(jobId: string, tab: WorkbenchTab, file?: string): string {
  return boldQuery(file ? { job: jobId, work: tab, file } : { job: jobId, work: tab })
}

/** The Work header's Workbench switch keeps the room's current job, message and note. */
export function boldWorkbenchLink(search: string): string {
  const params = new URLSearchParams(search)
  params.set('work', 'workbench')
  params.delete('file')
  return `/b?${params.toString()}`
}

/** The Work header's Results switch keeps the room's current job and note, and leaves the Workbench. */
export function boldResultsLink(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('work')
  params.delete('file')
  return params.size > 0 ? `/b?${params.toString()}` : '/b'
}

/** 11.6b: an agent's full screen, reached from the Workbench and the agent page. */
export function boldAgentScreenLink(agentId: string): string {
  return `/b/screen/${encodeURIComponent(agentId)}`
}

/** 11.8b: the agent's Workspace tab (inside More), optionally on one file. */
export function boldAgentWorkspaceLink(agentId: string, path?: string): string {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return `/b/team/${encodeURIComponent(agentId)}${query}#agent-workspace`
}

/** Normalises the paths workspace links and Workbench files use before comparing them. */
function samePath(one: string, other: string): boolean {
  const clean = (path: string) => path.replace(/^\.\//u, '').replace(/^\/+/u, '')
  return clean(one) === clean(other)
}

/**
 * 11.6b: a `workspace://` link from a message. It opens the job's Workbench when the path is one of the files that job
 * changed, else the authoring agent's Workspace tab. The room passes the job it is showing and the job's changed files.
 */
export function boldWorkspaceLink(
  agentId: string,
  path: string,
  job?: { id: string; files: readonly string[] },
): string {
  if (job?.files.some((file) => samePath(file, path))) return workbenchHref(job.id, 'code', path)
  return boldAgentWorkspaceLink(agentId, path)
}
