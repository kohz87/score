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

/** 11.7 one-to-ones: open an agent's home. */
export function boldOneToOneLink(agentId: string): string {
  return boldQuery({ with: agentId })
}

/** 11.10e Library: open a note. */
export function boldNoteLink(path: string): string {
  return boldQuery({ note: path })
}

/** 11.10c Start a job: open its dialog. */
export function boldStartJobLink(): string {
  return boldQuery({ start: 'job' })
}

/** 11.10d Recipe editor: open it. */
export function boldRecipesLink(): string {
  return boldQuery({ recipes: '1' })
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
