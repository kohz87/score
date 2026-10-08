import type { AgentId } from '@score/contract'

export const COMMANDS = [
  { name: 'assign', usage: '/assign @agent <title> [-- body]', description: 'Create a task.' },
  {
    name: 'routine',
    usage: '/routine @agent <schedule> <prompt>',
    description: 'Create a scheduled routine.',
  },
  { name: 'remember', usage: '/remember [@agent…] <fact>', description: 'Save a fact to memory.' },
  {
    name: 'skill',
    usage: '/skill @agent <name> | /skill install <name>',
    description: 'Use or install a skill.',
  },
  {
    name: 'model',
    usage: '/model <model> <message…>',
    description: 'Use a model for this message.',
  },
] as const

export type CommandName = (typeof COMMANDS)[number]['name']
export type ParsedCommand =
  | { kind: 'assign'; agentId: AgentId; title: string; body: string | null }
  | { kind: 'routine'; agentId: AgentId; schedule: string; prompt: string }
  | { kind: 'remember'; agents: AgentId[]; fact: string }
  | { kind: 'skill'; action: 'use'; agentId: AgentId; name: string }
  | { kind: 'skill'; action: 'install'; name: string }
  | { kind: 'model'; model: string; message: string }
  | { kind: 'invalid'; command: CommandName; error: string; usage: string }

export interface ParsedMessage {
  text: string
  mentions: AgentId[]
  unknownMentions: string[]
  command: ParsedCommand | null
}

const agentToken = /^@([a-z0-9][a-z0-9_-]*)$/u
const duration = /^[1-9]\d*[mhd]$/u
const cronField = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\d+(?:-\d+)?)(?:\/\d+)?)*$/u
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function validCronField(field: string, index: number): boolean {
  const names = index === 3 ? months : index === 4 ? weekdays : []
  const numeric = field.replace(/\b[a-z]+\b/giu, (name: string, offset: number) => {
    if (field[offset - 1] === '/') return name
    const position = names.indexOf(name.toLowerCase())
    return position === -1 ? name : String(position)
  })
  return cronField.test(numeric)
}

function escaped(text: string, index: number): boolean {
  let slashes = 0
  while (text[--index] === '\\') slashes++
  return slashes % 2 === 1
}

function blank(text: string): string {
  // Preserve offsets (including surrogate pairs) and line endings for the later scans.
  return text.replace(/[^\r\n]/g, ' ')
}

function outsideCode(text: string): string {
  let fence: { marker: string; length: number } | null = null
  let visible = ''
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0]
    if (!line) continue
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/u.exec(line)
    if (fence) {
      visible += blank(line)
      if (
        marker &&
        marker[1]![0] === fence.marker &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null
    } else if (marker && (marker[1]![0] === '~' || !marker[2]!.includes('`'))) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length }
      visible += blank(line)
    } else {
      visible += line
    }
  }

  const ticks = [...visible.matchAll(/`+/g)]
  const nextByLength = new Map<number, number>()
  const closers = new Map<number, number>()
  for (let i = ticks.length - 1; i >= 0; i--) {
    const length = ticks[i]![0].length
    const next = nextByLength.get(length)
    if (next !== undefined) closers.set(i, next)
    nextByLength.set(length, i)
  }
  const spans: { start: number; end: number }[] = []
  for (let i = 0; i < ticks.length; i++) {
    const open = ticks[i]!
    if (escaped(visible, open.index)) continue
    // Backslashes inside a code span are literal, so they cannot escape its closer.
    const close = closers.get(i)
    if (close === undefined) continue
    const end = ticks[close]!.index + ticks[close]![0].length
    spans.push({ start: open.index, end })
    i = close
  }
  return maskSpans(visible, spans)
}

function maskSpans(text: string, spans: readonly { start: number; end: number }[]): string {
  let result = ''
  let cursor = 0
  for (const { start, end } of spans) {
    if (start < cursor) continue
    result += text.slice(cursor, start) + blank(text.slice(start, end))
    cursor = end
  }
  return result + text.slice(cursor)
}

function mentionText(text: string): string {
  const visible = outsideCode(text)
  // Include Markdown destinations and bare domain paths, as well as explicit URL schemes.
  const urls =
    /\]\(\s*(?:<[^>]*>|[^)]*)\)|(?<![\p{L}\p{N}_@])(?:[a-z][a-z0-9+.-]*:|www\.|\/\/)[^\s<>]+|(?:[\p{L}\p{N}-]+\.)+[a-z]{2,}[/?#][^\s<>]+/giu
  return maskSpans(
    visible,
    [...visible.matchAll(urls)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  )
}

function mentionsIn(text: string, known: ReadonlySet<AgentId>) {
  const mentions = new Set<AgentId>()
  const unknownMentions = new Set<string>()
  const visible = mentionText(text)
  for (const match of visible.matchAll(/@([a-z0-9][a-z0-9_-]*)/g)) {
    const before = visible.slice(Math.max(0, match.index - 2), match.index)
    const after = visible.slice(match.index + match[0].length, match.index + match[0].length + 3)
    if (
      escaped(visible, match.index) ||
      /[\p{L}\p{N}\p{M}_.+\-@/]$/u.test(before) ||
      /^[\p{L}\p{N}\p{M}_@-]/u.test(after) ||
      /^\.[\p{L}\p{N}]/u.test(after)
    )
      continue
    const id = match[1]!
    if (known.has(id)) mentions.add(id)
    else unknownMentions.add(id)
  }
  return { mentions: [...mentions], unknownMentions: [...unknownMentions] }
}

function takeToken(text: string): { token: string; rest: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(text.trimStart())
  return { token: match?.[1] ?? '', rest: match?.[2] ?? '' }
}

function parseCommand(text: string, known: ReadonlySet<AgentId>): ParsedCommand | null {
  const prefix = /^\/(\S+)/u.exec(text)
  const metadata = COMMANDS.find(({ name }) => name === prefix?.[1])
  if (!metadata) return null
  const kind = metadata.name
  const args = text.slice(kind.length + 1).trimStart()
  const invalid = (error: string): ParsedCommand => ({
    kind: 'invalid',
    command: kind,
    error,
    usage: metadata.usage,
  })
  const target = (token: string) => {
    const id = agentToken.exec(token)?.[1]
    return id && known.has(id) ? id : null
  }
  const targetError = (token: string) =>
    agentToken.test(token) ? `Unknown agent: ${token}.` : 'Expected a known @agent.'
  const { token, rest } = takeToken(args)

  switch (kind) {
    case 'assign': {
      const agentId = target(token)
      if (!agentId) return invalid(targetError(token))
      const separator = /(?:^|\s)--(?=\s|$)/u.exec(outsideCode(rest))
      const title = (separator ? rest.slice(0, separator.index) : rest).trim()
      if (!title) return invalid('Missing task title.')
      const body = separator ? rest.slice(separator.index + separator[0].length).trim() : null
      if (body === '') return invalid('Missing task body after --.')
      return { kind, agentId, title, body }
    }
    case 'routine': {
      const agentId = target(token)
      if (!agentId) return invalid(targetError(token))
      const scheduleMatch =
        /^(?:(["'])(.*?)\1|((?:every|daily)\s+\S+|\S+))(?:\s+([\s\S]*))?$/u.exec(rest)
      if (!scheduleMatch) return invalid('Missing schedule and prompt.')
      const schedule = scheduleMatch[2] ?? scheduleMatch[3]!
      const quoted = scheduleMatch[1] !== undefined
      const fields = schedule.trim().split(/\s+/u)
      const valid = quoted
        ? fields.length === 5 && fields.every(validCronField)
        : duration.test(schedule) ||
          /^every\s+[1-9]\d*[mhd]$/u.test(schedule) ||
          /^daily\s+(?:[01]\d|2[0-3]):[0-5]\d$/u.test(schedule)
      if (!valid)
        return invalid('Invalid schedule. Use 5m, every 15m, "0 9 * * *", or daily 09:00.')
      const prompt = (scheduleMatch[4] ?? '').trim()
      if (!prompt) return invalid('Missing routine prompt.')
      return { kind, agentId, schedule, prompt }
    }
    case 'remember': {
      const agents = new Set<AgentId>()
      let fact = args
      while (fact.startsWith('@')) {
        const next = takeToken(fact)
        const agentId = target(next.token)
        if (!agentId) return invalid(targetError(next.token))
        agents.add(agentId)
        fact = next.rest
      }
      if (!fact.trim()) return invalid('Missing fact to remember.')
      return { kind, agents: [...agents], fact: fact.trim() }
    }
    case 'skill': {
      const name = rest.trim()
      if (token !== 'install' && !target(token)) return invalid(targetError(token))
      if (!name) return invalid('Missing skill name.')
      if (/\s/u.test(name)) return invalid('Expected one skill name.')
      return token === 'install'
        ? { kind, action: 'install', name }
        : { kind, action: 'use', agentId: target(token)!, name }
    }
    case 'model':
      if (!token) return invalid('Missing model and message.')
      if (!rest.trim()) return invalid('Missing message for the model.')
      return { kind, model: token, message: rest }
  }
}

export function parseMessage(text: string, agents: readonly AgentId[]): ParsedMessage {
  const known = new Set(agents)
  const command = parseCommand(text, known)
  const messageText = command?.kind === 'model' ? command.message : text
  return { text: messageText, ...mentionsIn(messageText, known), command }
}
