import type { AgentSummary } from '@score/contract'
import type { QueryKey } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { UploadProgress } from '../../data/api.ts'
import type { Attachment } from './attachments.ts'
import type { CommandResult, SlashCommand } from './composer-model.ts'
import type { MessagePageData } from './queries.ts'

export type Notice =
  | {
      kind: 'error'
      text: string
      heldAgent?: string
      action?: { label: string; to: string }
      retry?: { label: string; run: () => void }
    }
  | { kind: 'info'; text: string }
  | { kind: 'result'; command: CommandResult | null }

export type Snapshot = { asOfSeq: number; data: MessagePageData }
export type LiveDraft = { text: string; attachments: Attachment[] }
export type SendingFile = { key: number; name: string; progress: UploadProgress }

export type TopicCommands = {
  items: SlashCommand[]
  /** Names that run when typed but are not offered in the `/` palette. */
  typedOnly?: string[]
  /** Palette items for the one agent a bare command acts on (`/effort`'s levels); none when there isn't one. */
  menuFor?: (addressee: string | null) => SlashCommand[]
  /** `target` is the agent the command acts on: the addressee, or the one named before it (`@agent /effort max`). */
  run: (name: string, args: string, target?: string) => Promise<void>
}

export type ComposerFooterState = {
  to: string[]
  subject: string | null
  /** Changes on every finished reply: a context reading in the footer refreshes. */
  finishedReplies: number
  /** Bumped by `/compress`: the footer's meter opens its compaction confirmation (for `compactSubject`). */
  compactSignal: number
  compactSubject: string | null
}

export type ComposerProps = {
  roomId: string
  roomName: string
  agents: AgentSummary[]
  /**
   * 3.7.10: who @ and To offer (default: `agents`). `agents` stays the full list, so an edited message to a removed agent
   * still shows its name.
   */
  offered?: AgentSummary[]
  leadAgentId?: string | null
  /** The user view's first message opens its room once it is sent (PLAN 8.4). */
  onSent?: () => void
  /**
   * Where `/compress` goes when the composer shows no context ring of its own (the new shell's chats keep the ring in
   * their footer): the owner of that ring opens its confirmation.
   */
  onCompress?: () => void
  /**
   * The user view starts orchestrations from the composer (PLAN 8.4): the "+" menu gets "Start an orchestration…",
   * and `/orchestrate <goal>` calls this with the goal (empty when none was typed).
   */
  orchestrate?: (goal: string) => void
  /** The job (thread) a room message is posted in (PLAN 11.1b); null posts in the room's default job. */
  jobId?: string | null
  /** The bold team room's one-line composer, using the same send, upload and voice logic. */
  roomMode?: boolean
  /** The room composer's fixed To chip ("To: new job" or "To: <job title>"). */
  toLabel?: string
  placeholder?: string
  /** Holds the composer (typing and sending off) with this reason as its placeholder, e.g. while the topic loads. */
  hold?: string
  /** The live message page the composer sends into; defaults to the classic room's default-job thread. */
  messagesKey?: QueryKey
  /** Text to load once on mount, taking precedence over the stored draft (the bold room's command hand-off). */
  initialText?: string
  /** Jobs this message refers to (PLAN 11.2 §6.3); the server freezes each one into a `ref` part. */
  references?: readonly { jobId: string }[]
  /** Where the draft is stored when it is not the room's (the one-to-one keeps one per chat). */
  draftScope?: string
  /** Makes the job this message goes into on first send (a one-to-one that is only created by its first message). */
  resolveJob?: () => Promise<string>
  /** The bold room reopens a job the server refused as closed, then sends the same message into it. */
  onClosedJob?: (jobId: string) => Promise<void>
  /**
   * 3.22.0: the chat commands (/new, /rename, /done, …). Listed in the palette; `run` does the work and throws an Error
   * with plain words when it can't, which this composer shows and then keeps the typed text.
   */
  topicCommands?: TopicCommands
  /** 3.22.0: replaces the hint line under the box (the chat's context bar) and the fixed "To" label. */
  footer?: (state: ComposerFooterState) => ReactNode
}
