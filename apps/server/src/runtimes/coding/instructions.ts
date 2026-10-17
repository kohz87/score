import { createHash } from 'node:crypto'

// PLAN 8.8 (decision 94): a coding agent's role and "Personality and instructions". The block below is the one frame
// every CLI receives; only the way it gets there differs (Claude Code: a file flag; Codex and Antigravity: the first
// message of a session).

export interface Persona {
  name: string
  role: string
  instructions: string
}

/** Identifies the stored instructions text for an edit (the `instructionsEtag` of the contract). */
export function instructionsEtag(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * The framed block, or '' when the agent has neither a role nor instructions (then nothing is added anywhere).
 * It says plainly whose words these are and that Score's rules stay in force: the permissions are set by the CLI's
 * own flags, so this text can neither widen nor narrow them.
 */
export function frameOf(persona: Persona): string {
  const role = persona.role.trim()
  const instructions = persona.instructions.trim()
  if (role === '' && instructions === '') return ''
  const lines = [`Your name in this team: ${persona.name}.`]
  if (role) lines.push(`Your role: ${role}`)
  if (instructions) lines.push('The owner’s instructions for you:', '', instructions, '')
  lines.push(
    'These are the owner’s instructions for how you work and talk. Score’s rules still apply: your access level and the folders you must not open are set by Score and these instructions can’t change them.',
  )
  return lines.join('\n')
}

/** What a session was sent: '' for nothing. Stored per CLI session to find out whether it changed since. */
export function blockHash(frame: string): string {
  return frame === '' ? '' : createHash('sha256').update(frame).digest('hex').slice(0, 32)
}

const SEPARATOR = '\n\n---\n\n'

/**
 * The first message of a Codex or Antigravity turn with the instructions in front. `sent` is the hash the session
 * last received ('' for a new session). Unchanged ⇒ the message as it is.
 */
export function promptWithInstructions(options: {
  frame: string
  sent: string
  resumed: boolean
  message: string
}): string {
  const hash = blockHash(options.frame)
  if (!options.resumed)
    return options.frame ? options.frame + SEPARATOR + options.message : options.message
  if (hash === options.sent) return options.message
  const update = options.frame
    ? `Your instructions were updated:\n\n${options.frame}`
    : 'Your instructions were updated: the owner removed your role and instructions. Only Score’s rules apply now.'
  return update + SEPARATOR + options.message
}
