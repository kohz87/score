import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { Dispatch, SetStateAction } from 'react'
import { apiFetch, ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { roomHasLiveShare } from '../../data/shares.ts'
import { attachmentKey, toPart, toRequest, type Attachment } from './attachments.ts'
import {
  loadDraft,
  parseSendResult,
  saveDraft,
  withMessage,
  withoutMessage,
  type SlashCommand,
} from './composer-model.ts'
import type { LiveDraft, Notice, Snapshot, TopicCommands } from './composer-types.ts'
import { LOCAL_COMMAND_MENU, parseLocalCommand } from './context-meter.ts'
import { stopEdit, type Editing } from './message-edit.ts'
import type { MessagePageData } from './queries.ts'
import { fetchRewindPlan, postRewind } from './rewind.ts'
import type { EditStash } from './use-composer-editing.ts'

type LocalCommand = NonNullable<ReturnType<typeof parseLocalCommand>>

export type ComposerSendInput = {
  roomId: string
  roomMode: boolean
  draftScope?: string
  jobId: string | null
  hold?: string
  orchestrate?: (goal: string) => void
  topicCommands?: TopicCommands
  references: readonly { jobId: string }[]
  resolveJob?: () => Promise<string>
  onSent?: () => void
  onClosedJob?: (jobId: string) => Promise<void>
  text: string
  editing: Editing | null
  pending: boolean
  uploading: number
  attachments: Attachment[]
  to: string[]
  /** The one agent a bare command acts on (see Composer): the To chip, else the agent the footer names; null when it isn't one. */
  addressee: string | null
  planFirst: boolean
  setText: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setTo: Dispatch<SetStateAction<string[]>>
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  setPending: Dispatch<SetStateAction<boolean>>
  setRewinding: Dispatch<SetStateAction<boolean>>
  setNotice: Dispatch<SetStateAction<Notice | null>>
  setConfirmEdit: Dispatch<SetStateAction<boolean>>
  setLoadedEdit: Dispatch<SetStateAction<string | null>>
  setStash: Dispatch<SetStateAction<EditStash | null>>
  stash: EditStash | null
  editSession: { current: number }
  rewoundEdit: { current: string | null }
  rewindKey: { current: { messageId: string; key: string } | null }
  sendKey: { current: { signature: string; key: string } | null }
  roomMessagesKey: QueryKey
  queryClient: QueryClient
  commands: SlashCommand[] | undefined
  runLocalCommand: (command: LocalCommand) => Promise<void>
  saveSentToKnowledge: (sent: Attachment[]) => Promise<void>
  latest: { current: { leaveEdit: () => void } }
  latestSend: { current: (force?: boolean) => Promise<void> }
  mounted: { current: boolean }
  live: { current: LiveDraft }
  textarea: { current: HTMLTextAreaElement | null }
}

function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Couldn’t send the message. Try again.'
  const details =
    typeof error.details === 'object' && error.details !== null
      ? (error.details as { error?: unknown; usage?: unknown })
      : {}
  const reason = typeof details.error === 'string' ? details.error : null
  const usage = typeof details.usage === 'string' ? `Usage: ${details.usage}` : null
  if (error.status === 409 && error.code === 'orchestration_owned')
    return 'This room belongs to a running orchestration. Use the run controls above instead.'
  if (error.status === 501)
    return ['That command isn’t available yet.', usage].filter(Boolean).join(' ')
  if (reason || usage) return [reason, usage].filter(Boolean).join(' ')
  return error.message
}

export function useComposerSend({
  roomId,
  roomMode,
  draftScope,
  jobId,
  hold,
  orchestrate,
  topicCommands,
  addressee,
  references,
  resolveJob,
  onSent,
  onClosedJob,
  text,
  editing,
  pending,
  uploading,
  attachments,
  to,
  planFirst,
  setText,
  setCaret,
  setTo,
  setAttachments,
  setPending,
  setRewinding,
  setNotice,
  setConfirmEdit,
  setLoadedEdit,
  setStash,
  stash,
  editSession,
  rewoundEdit,
  rewindKey,
  sendKey,
  roomMessagesKey,
  queryClient,
  commands,
  runLocalCommand,
  saveSentToKnowledge,
  latest,
  latestSend,
  mounted,
  live,
  textarea,
}: ComposerSendInput) {
  return async function send(force = false) {
    const body = text.trim()
    // Reopen resends through the closure captured before the failed send; only that retry may bypass its stale
    // `pending` flag (the request it belonged to has already failed).
    if (!body || hold || (pending && !force) || uploading) return
    const orchestration =
      orchestrate && !editing ? /^\/orchestrate(?:\s+([\s\S]*))?$/i.exec(body) : null
    if (orchestrate && orchestration) {
      setText('')
      setCaret(0)
      orchestrate((orchestration[1] ?? '').trim())
      return
    }
    const local = editing ? null : parseLocalCommand(body)
    if (local) return runLocalCommand(local)
    // `@agent /effort <level>` (decision 178) names the agent in front of the command; it is never posted as a message.
    const addressed =
      !editing && topicCommands ? /^@([\w-]+)\s+\/effort(?:\s+([\s\S]*))?$/i.exec(body) : null
    const typed =
      !editing && topicCommands && !addressed ? /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(body) : null
    if ((addressed || typed) && topicCommands) {
      const word = addressed ? 'effort' : typed![1]!.toLowerCase()
      const args = (addressed ? addressed[2] : typed![2]) ?? ''
      // A bare command acts on the addressee (see Composer): the one To chip, else the agent the footer names.
      const target = addressed ? addressed[1] : (addressee ?? undefined)
      if (
        addressed ||
        topicCommands.items.some((item) => item.name === word) ||
        topicCommands.typedOnly?.includes(word)
      ) {
        setNotice(null)
        setPending(true)
        try {
          await topicCommands.run(word, args.trim(), target)
          setText('')
          setCaret(0)
        } catch (error) {
          setNotice({
            kind: 'error',
            text: error instanceof Error ? error.message : 'That command failed. Try again.',
          })
        } finally {
          setPending(false)
        }
        return
      }
      const known =
        commands?.some((item) => item.name === word) ||
        LOCAL_COMMAND_MENU.some((item) => item.name === word) ||
        (orchestrate && word === 'orchestrate')
      // Only once the server's list is here: before that an unknown word may just be one it has not told us about.
      if (!known && commands && !topicCommands.effortOnly) {
        setNotice({
          kind: 'error',
          text: `I don’t know /${word}. Type / to see the commands.`,
        })
        return
      }
    }
    // Editing rewinds the room and the agents first (PLAN 5.33). When every agent can be rewound and nothing is still
    // running, Score does it on Send without asking (owner, 2.0.12); otherwise the dialog explains and offers the way
    // out (stop the work first, or hide in Score only).
    if (editing && !editing.rewound && rewoundEdit.current !== editing.messageId) {
      setPending(true)
      setRewinding(true)
      setNotice(null)
      let clean: boolean
      try {
        // A rewind already sent for this message (its answer lost) is repeated with the same key, not re-planned: the
        // server returns the stored result, and a plan for an already-hidden message would fail.
        const retrying = rewindKey.current?.messageId === editing.messageId
        // A share link made since the lost answer still needs the dialog's revoke offer.
        if (retrying) clean = !(await roomHasLiveShare(queryClient, roomId))
        else {
          const plan = await fetchRewindPlan(roomId, editing.messageId)
          // A live share link keeps showing the old message: the dialog says so and offers to revoke it.
          clean =
            !plan.blocked &&
            plan.agents.every((agent) => !agent.cannot) &&
            !(await roomHasLiveShare(queryClient, roomId))
        }
        if (clean) {
          if (!retrying) rewindKey.current = { messageId: editing.messageId, key: newId() }
          await postRewind(roomId, editing.messageId, 'edit', false, rewindKey.current!.key)
          rewoundEdit.current = editing.messageId
        }
      } catch (caught) {
        // A refusal or an incomplete rewind: the dialog reads the plan again and says what happened. Anything else (a
        // dropped connection) keeps the edit as it is; Send again repeats the same rewind request.
        // Only a lost answer is worth repeating as it is (no answer, a server error, a timeout or rate limit); any other
        // refusal is final and the dialog says what changed.
        const transient =
          !(caught instanceof ApiError) ||
          caught.status >= 500 ||
          caught.status === 408 ||
          caught.status === 429
        if (transient) {
          setPending(false)
          setRewinding(false)
          setNotice({ kind: 'error', text: 'Couldn’t send the correction. Try again.' })
          return
        }
        // A refusal is final for that request: the next Send plans again.
        rewindKey.current = null
        clean = false
      }
      setPending(false)
      setRewinding(false)
      if (!clean) {
        setConfirmEdit(true)
        return
      }
    }
    const sent = attachments
    let sentJobId = editing?.jobId ?? jobId
    if (resolveJob && !editing) {
      setPending(true)
      setNotice(null)
      try {
        sentJobId = await resolveJob()
      } catch {
        setPending(false)
        setNotice({ kind: 'error', text: 'Couldn’t start the chat. Try again.' })
        return
      }
    }
    const payload = {
      text: body,
      ...(sent.length ? { attachments: sent.map(toRequest) } : {}),
      // An edit that omits `to` reuses the original recipients, so removing every chip must say so explicitly.
      ...(to.length || editing ? { to } : {}),
      ...(planFirst ? { planFirst: true } : {}),
      ...(editing ? { edits: editing.messageId } : {}),
      ...(sentJobId ? { jobId: sentJobId } : {}),
      ...(references.length
        ? { refs: references.map((reference) => ({ jobId: reference.jobId })) }
        : {}),
    }
    const submittedSession = editSession.current
    // A retry of the same payload reuses its key, so a lost response cannot post twice.
    const signature = JSON.stringify(payload)
    if (sendKey.current?.signature !== signature) sendKey.current = { signature, key: newId() }
    const key = sendKey.current.key
    const temporary = `pending-${key}`
    const queryKey = roomMessagesKey
    const update = (change: (data: MessagePageData) => MessagePageData) => {
      const snapshot = queryClient.getQueryData<Snapshot>(queryKey)
      if (snapshot) queryClient.setQueryData(queryKey, { ...snapshot, data: change(snapshot.data) })
    }
    setPending(true)
    setNotice(null)
    update((data) =>
      withMessage(data, {
        id: temporary,
        roomId,
        author: { kind: 'you' },
        to,
        ...(sentJobId ? { jobId: sentJobId } : {}),
        ...(editing ? { edits: editing.messageId } : {}),
        parts: [{ kind: 'text', text: body }, ...sent.map(toPart)],
        createdAt: new Date().toISOString(),
        streaming: false,
        refs: [],
      }),
    )
    try {
      const result = parseSendResult(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(payload),
        }),
      )
      update((data) => withMessage(data, result.message, temporary))
      sendKey.current = null
      void saveSentToKnowledge(sent)
      if (!editing) onSent?.()
      if (!mounted.current) {
        // The composer moved to another conversation mid-send: only drop the stored draft if it is still what we sent.
        if (loadDraft(draftScope ?? roomId).trim() === body) saveDraft(draftScope ?? roomId, '')
        return
      }
      if (editing) {
        // Only the edit that sent this is finished by it; a cancelled or replaced edit left the composer to the person.
        if (editSession.current === submittedSession) {
          if (live.current.text.trim() === body) latest.current.leaveEdit()
          else {
            // The person kept typing: that stays, and the draft stashed before the edit comes back before it.
            stopEdit()
            setLoadedEdit(null)
            if (stash) {
              const typed = live.current.text
              const restored = stash.text.trim() ? `${stash.text}\n\n${typed}` : typed
              setText(restored)
              setCaret(restored.length)
              setTo(stash.to)
              setAttachments((current) => [...stash.attachments, ...current])
              setStash(null)
            }
          }
        }
        setNotice(
          result.notices?.length
            ? { kind: 'info', text: result.notices.join(' ') }
            : { kind: 'result', command: result.command },
        )
        return
      }
      // Keep whatever was typed or attached while the request was in flight.
      if (live.current.text.trim() === body) {
        setText('')
        setCaret(0)
      }
      setAttachments((current) =>
        current.filter((item) => !sent.some((done) => attachmentKey(done) === attachmentKey(item))),
      )
      setNotice(
        result.notices?.length
          ? { kind: 'info', text: result.notices.join(' ') }
          : { kind: 'result', command: result.command },
      )
    } catch (error) {
      update((data) => withoutMessage(data, temporary))
      const held =
        error instanceof ApiError && error.code === 'agent_still_stopping'
          ? (error.details as { agentId?: unknown } | undefined)?.agentId
          : undefined
      const noLead = error instanceof ApiError && error.code === 'no_lead'
      const jobClosed =
        error instanceof ApiError &&
        error.status === 409 &&
        Boolean(sentJobId) &&
        Boolean(onClosedJob) &&
        /job is closed/i.test(error.message)
      setNotice({
        kind: 'error',
        text: jobClosed
          ? 'This job is closed. Reopen it to write in it.'
          : noLead
            ? 'No lead yet — use @name, or pick a lead in Settings.'
            : errorText(error),
        ...(typeof held === 'string' ? { heldAgent: held } : {}),
        ...(jobClosed && sentJobId && onClosedJob
          ? {
              retry: {
                label: 'Reopen',
                run: () => {
                  void (async () => {
                    setPending(true)
                    setNotice(null)
                    try {
                      await onClosedJob(sentJobId)
                    } catch {
                      setNotice({
                        kind: 'error',
                        text: 'Couldn’t reopen this job. Try again.',
                      })
                      setPending(false)
                      return
                    }
                    setPending(false)
                    await latestSend.current(true)
                  })()
                },
              },
            }
          : {}),
        // Only the new shell's room links into it; the classic chat keeps the plain sentence.
        ...(noLead && roomMode ? { action: { label: 'Pick a lead', to: '/b/settings' } } : {}),
      })
    } finally {
      if (mounted.current) {
        setPending(false)
        textarea.current?.focus()
      }
    }
  }
}
