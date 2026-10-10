import type { AgentSummary } from '@score/contract'
import { sendsOnKey } from '../../data/send-key.ts'
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { AgentGlyph, agentTint } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { agentTextColor } from './agent-text-color.ts'
import {
  insertMention,
  loadDraft,
  mentionAt,
  parseCommands,
  parseSendResult,
  saveDraft,
  slashQuery,
  withMessage,
  withoutMessage,
  type CommandResult,
  type SlashCommand,
} from './composer-model.ts'
import {
  agentContextKey,
  fetchAgentContext,
  LOCAL_COMMAND_MENU,
  meterFraction,
  meterText,
  parseLocalCommand,
  usageSummary,
} from './context-meter.ts'
import { messagesQuery, type MessagePageData } from './queries.ts'
import { useVoiceInput } from './voice.ts'
import { newId } from '../../data/ids.ts'
import { stopEdit, useEditing } from './message-edit.ts'
import { RewindDialog } from './RewindDialog.tsx'
import {
  ACCEPT,
  attachmentKey,
  attachmentName,
  isImage,
  MAX_ATTACHMENTS,
  parseUpload,
  toPart,
  toRequest,
  uploadProblem,
  type Attachment,
} from './attachments.ts'
import { WorkspacePicker } from './WorkspacePicker.tsx'

type Notice =
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'result'; command: CommandResult | null }
type Snapshot = { asOfSeq: number; data: MessagePageData }

function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not send the message. Please try again.'
  const details =
    typeof error.details === 'object' && error.details !== null
      ? (error.details as { error?: unknown; usage?: unknown })
      : {}
  const reason = typeof details.error === 'string' ? details.error : null
  const usage = typeof details.usage === 'string' ? `Usage: ${details.usage}` : null
  if (error.status === 409 && error.code === 'orchestration_owned')
    return 'This room belongs to a running orchestration. Use the run controls above instead.'
  if (error.status === 501)
    return ['That command is not available yet.', usage].filter(Boolean).join(' ')
  if (reason || usage) return [reason, usage].filter(Boolean).join(' ')
  return error.message
}

function CommandNotice({ command }: { command: CommandResult | null }) {
  if (!command) return null
  if (command.kind === 'assign')
    return (
      <>
        Created task{' '}
        <Link to={`/tasks/${encodeURIComponent(command.taskId)}`}>{command.taskKey}</Link>
      </>
    )
  if (command.kind === 'model') return <>Sent using {command.model}</>
  return <>Command applied</>
}

export function Composer({
  roomId,
  roomName,
  agents,
  leadAgentId = null,
}: {
  roomId: string
  roomName: string
  agents: AgentSummary[]
  leadAgentId?: string | null
}) {
  const queryClient = useQueryClient()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const sendKey = useRef<{ signature: string; key: string } | null>(null)
  const ids = useId()
  const [text, setText] = useState(() => loadDraft(roomId))
  const [caret, setCaret] = useState(0)
  const [to, setTo] = useState<string[]>([])
  const [planFirst, setPlanFirst] = useState(false)
  const [picker, setPicker] = useState(false)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [attachMenu, setAttachMenu] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Latest values for the send callback, which resolves long after the closure was created.
  const live = useRef({ text, attachments })
  useEffect(() => {
    live.current = { text, attachments }
  })
  const latest = useRef({ leaveEdit: () => {} })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const fileInput = useRef<HTMLInputElement>(null)

  // Edit and resend: the message loads into the composer; what was there before comes back afterwards.
  const editingNow = useEditing()
  const editing = editingNow?.roomId === roomId ? editingNow : null
  const editId = editing?.messageId ?? null
  const [stash, setStash] = useState<{
    text: string
    to: string[]
    attachments: Attachment[]
  } | null>(null)
  const [loadedEdit, setLoadedEdit] = useState<string | null>(null)
  if (editId !== loadedEdit) {
    // Adjusting state while rendering: only a different message reloads the composer.
    setLoadedEdit(editId)
    if (editing) {
      setStash((saved) => saved ?? { text, to, attachments })
      setText(editing.text)
      setCaret(editing.text.length)
      setTo(editing.to)
      setAttachments(editing.attachments)
      setPlanFirst(false)
      setNotice(null)
    }
  }
  // Counts edit sessions, so a response can tell whether the edit it belongs to is still the one on screen.
  const editSession = useRef(0)
  useEffect(() => {
    editSession.current += 1
    if (editId) textarea.current?.focus()
  }, [editId])
  function leaveEdit() {
    stopEdit()
    setLoadedEdit(null)
    if (!stash) return
    setText(stash.text)
    setCaret(stash.text.length)
    setTo(stash.to)
    setAttachments(stash.attachments)
    setStash(null)
  }
  useEffect(() => {
    latest.current = { leaveEdit }
  })
  useEffect(() => () => stopEdit(), [])
  // The message whose rewind already happened: a failed send is retried without asking again.
  const rewoundEdit = useRef<string | null>(null)
  const [confirmEdit, setConfirmEdit] = useState(false)

  const commands = useQuery({
    queryKey: ['chat', 'commands'],
    queryFn: async () => parseCommands(await apiFetch('commands')),
    staleTime: Infinity,
  })

  // The room's messages are kept live by the stream; a reply being written turns Send into Stop (PLAN 5.25).
  const thread = useQuery<{ asOfSeq: number; data: MessagePageData } | undefined>({
    queryKey: messagesQuery(roomId).key,
    queryFn: skipToken,
  })
  const items = thread.data?.data.items
  const writing = useMemo(
    () => (items ?? []).filter((item) => item.streaming && item.author.kind === 'agent'),
    [items],
  )
  const [stopping, setStopping] = useState(false)
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(stopTimer.current), [])
  async function stopReplies() {
    setStopping(true)
    try {
      await Promise.all(
        writing.map((item) =>
          apiFetch(
            `rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(item.id)}/stop`,
            { method: 'POST', headers: { 'Idempotency-Key': newId() }, body: '{}' },
          ),
        ),
      )
    } catch {
      setNotice({ kind: 'error', text: 'Could not stop the reply. It may have just finished.' })
    } finally {
      // The reply's own completion event ends the Stop state; this only guards a response that never comes.
      stopTimer.current = setTimeout(() => setStopping(false), 3000)
    }
  }

  // The agent the meter and /usage speak about: the first "To" chip, else whoever answered last, else the lead.
  const lastReplier = (items ?? []).find((item) => item.author.kind === 'agent')?.author
  const subject =
    to[0] ??
    (lastReplier?.kind === 'agent' ? lastReplier.agentId : null) ??
    (leadAgentId && agents.some((agent) => agent.id === leadAgentId) ? leadAgentId : null)
  const subjectAgent = agents.find((agent) => agent.id === subject)
  const finishedReplies = (items ?? []).filter((item) => !item.streaming).length
  const meter = useQuery({
    queryKey: [...agentContextKey(subject ?? ''), finishedReplies],
    queryFn: subject ? () => fetchAgentContext(subject) : skipToken,
    staleTime: 15_000,
    retry: false,
  })

  // Voice input: interim words replace each other in the draft until the utterance settles.
  const voiceBase = useRef('')
  const voice = useVoiceInput({
    onText: (heard) => {
      const base = voiceBase.current
      const next = heard ? `${base}${base && !/\s$/.test(base) ? ' ' : ''}${heard}` : base
      setText(next)
      setCaret(next.length)
    },
    onFinal: () => textarea.current?.focus(),
  })
  function toggleVoice() {
    if (voice.listening) voice.stop()
    else {
      voiceBase.current = text
      voice.start()
    }
  }

  useEffect(() => {
    if (!editId) saveDraft(roomId, text)
  }, [roomId, text, editId])

  const slash = slashQuery(text)
  const mention = slash === null ? mentionAt(text, caret) : null
  const slashItems: SlashCommand[] = useMemo(
    () =>
      slash === null
        ? []
        : [
            ...(commands.data ?? []),
            ...LOCAL_COMMAND_MENU.filter(
              (local) => !commands.data?.some((item) => item.name === local.name),
            ),
          ].filter((item) => item.name.startsWith(slash)),
    [slash, commands.data],
  )
  const mentionItems = useMemo(() => {
    if (!mention) return []
    const query = mention.query.toLowerCase()
    return agents.filter(
      (agent) =>
        agent.id.toLowerCase().startsWith(query) || agent.name.toLowerCase().startsWith(query),
    )
  }, [mention, agents])
  const menu = closed ? null : slashItems.length ? 'slash' : mentionItems.length ? 'mention' : null
  const count = menu === 'slash' ? slashItems.length : mentionItems.length
  const index = Math.min(active, Math.max(count - 1, 0))
  const optionId = (position: number) => `${ids}-option-${position}`

  function edit(value: string, position: number) {
    setText(value)
    setCaret(position)
    setActive(0)
    setClosed(false)
  }
  function select(position: number) {
    const area = textarea.current
    if (menu === 'slash') {
      const command = slashItems[position]
      if (!command) return
      const next = `/${command.name} `
      edit(next, next.length)
      requestAnimationFrame(() => area?.setSelectionRange(next.length, next.length))
    } else if (menu === 'mention' && mention) {
      const agent = mentionItems[position]
      if (!agent) return
      const next = insertMention(text, caret, mention.start, agent.id)
      edit(next.text, next.caret)
      requestAnimationFrame(() => area?.setSelectionRange(next.caret, next.caret))
    }
  }

  // Buttons, drag and drop and paste all end here. Every file is checked by the server from its bytes.
  async function upload(picked: File[]) {
    if (fileInput.current) fileInput.current.value = ''
    for (const file of picked) {
      const problem = uploadProblem(file)
      if (problem) {
        setNotice({ kind: 'error', text: problem })
        continue
      }
      if (live.current.attachments.length + uploadsInFlight.current >= MAX_ATTACHMENTS) {
        setNotice({
          kind: 'error',
          text: `A message can carry up to ${MAX_ATTACHMENTS} attachments.`,
        })
        break
      }
      uploadsInFlight.current += 1
      setUploading((count) => count + 1)
      try {
        const form = new FormData()
        form.append('file', file, file.name || 'pasted-file')
        const stored = parseUpload(await apiFetch('media', { method: 'POST', body: form }))
        changeAttachments((current) =>
          current.length >= MAX_ATTACHMENTS ||
          current.some((item) => attachmentKey(item) === stored.mediaId)
            ? current
            : [...current, stored],
        )
      } catch (error) {
        const reason =
          error instanceof ApiError && error.status === 413
            ? 'is too large (images up to 8 MB, other files up to 25 MB)'
            : error instanceof ApiError && error.status === 415
              ? 'is not a type that can be attached (images, PDF, DOCX, XLSX, TXT, Markdown, CSV, JSON, HTML)'
              : 'could not be uploaded'
        setNotice({ kind: 'error', text: `${file.name} ${reason}.` })
      } finally {
        uploadsInFlight.current -= 1
        setUploading((count) => count - 1)
      }
    }
  }
  const uploadsInFlight = useRef(0)
  // The ref moves first, so a loop of uploads counts what the previous one added before React re-renders.
  function changeAttachments(change: (current: Attachment[]) => Attachment[]) {
    const next = change(live.current.attachments)
    live.current = { ...live.current, attachments: next }
    setAttachments(next)
  }
  function addWorkspaceFile(agentId: string, path: string, root?: string) {
    changeAttachments((current) => {
      const item: Attachment = {
        kind: 'workspace',
        agentId,
        path,
        ...(root === undefined ? {} : { root }),
      }
      return current.length >= MAX_ATTACHMENTS ||
        current.some((existing) => attachmentKey(existing) === attachmentKey(item))
        ? current
        : [...current, item]
    })
  }

  // /compress, /usage and /model <name> are answered here (PLAN 5.25); other commands go to the server as before.
  async function runLocalCommand(command: NonNullable<ReturnType<typeof parseLocalCommand>>) {
    const name = subjectAgent?.name ?? subject
    setNotice(null)
    if (!subject || !name) {
      setNotice({ kind: 'error', text: 'Choose who this is for first: add someone to “To”.' })
      return
    }
    setText('')
    setCaret(0)
    try {
      if (command.kind === 'compress') {
        // Hermes only compacts a session from its own CLI or a messaging chat; its API has no call for it.
        setNotice({
          kind: 'info',
          text: `Hermes can’t compact ${name}’s session through its API yet, so /compress isn’t available here. Run /compress in the Hermes CLI for this profile.`,
        })
      } else if (command.kind === 'usage') {
        setNotice({ kind: 'info', text: usageSummary(name, await fetchAgentContext(subject)) })
      } else {
        await apiFetch(`agents/${encodeURIComponent(subject)}/model`, {
          method: 'PUT',
          body: JSON.stringify({ model: command.model }),
        })
        void queryClient.invalidateQueries({ queryKey: ['chat', 'context'] })
        setNotice({ kind: 'info', text: `${name} now uses ${command.model}.` })
      }
    } catch (error) {
      setText(`/${command.kind}${command.kind === 'model' ? ` ${command.model}` : ''}`)
      setNotice({
        kind: 'error',
        text:
          error instanceof ApiError && error.status === 400
            ? `${command.kind === 'model' ? command.model : 'That'} isn’t available for ${name}.`
            : 'That command failed. Please try again.',
      })
    }
  }

  async function send() {
    const body = text.trim()
    if (!body || pending || uploading) return
    const local = editing ? null : parseLocalCommand(body)
    if (local) return runLocalCommand(local)
    // Editing rewinds the room and the agents first (PLAN 5.33); the person confirms what that does.
    if (editing && !editing.rewound && rewoundEdit.current !== editing.messageId) {
      setConfirmEdit(true)
      return
    }
    const sent = attachments
    const payload = {
      text: body,
      ...(sent.length ? { attachments: sent.map(toRequest) } : {}),
      // An edit that omits `to` reuses the original recipients, so removing every chip must say so explicitly.
      ...(to.length || editing ? { to } : {}),
      ...(planFirst ? { planFirst: true } : {}),
      ...(editing ? { edits: editing.messageId } : {}),
    }
    const submittedSession = editSession.current
    // A retry of the same payload reuses its key, so a lost response cannot post twice.
    const signature = JSON.stringify(payload)
    if (sendKey.current?.signature !== signature) sendKey.current = { signature, key: newId() }
    const key = sendKey.current.key
    const temporary = `pending-${key}`
    const queryKey = messagesQuery(roomId).key
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
      if (!mounted.current) {
        // The composer moved to another conversation mid-send: only drop the stored draft if it is still what we sent.
        if (loadDraft(roomId).trim() === body) saveDraft(roomId, '')
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
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      if (mounted.current) {
        setPending(false)
        textarea.current?.focus()
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
    if (menu && count) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        select(index)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setClosed(true)
        return
      }
    }
    // Phones: Enter is a newline and the Send button sends. Desktop: the "Send with" setting decides.
    if (sendsOnKey(event)) {
      event.preventDefault()
      void send()
    }
  }

  const available = agents.filter((agent) => !to.includes(agent.id))
  // "From workspace…" browses the workspace of whoever the message goes to: the To chips, else the room lead.
  const pickerAgents = agents.filter((agent) =>
    to.length ? to.includes(agent.id) : agent.id === (leadAgentId ?? agents[0]?.id),
  )
  const lines = Math.min(Math.max(text.split('\n').length, 1), 8)
  return (
    <div className="chat-composer">
      {notice && (
        <div
          className={`chat-composer-notice${notice.kind === 'error' ? ' chat-composer-notice--error' : ''}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.kind === 'result' ? (
            <CommandNotice command={notice.command} />
          ) : (
            <span className="chat-usage-card">{notice.text}</span>
          )}
        </div>
      )}
      {menu && count > 0 && (
        <div
          className="chat-menu"
          role="listbox"
          id={`${ids}-menu`}
          aria-label={menu === 'slash' ? 'Commands' : 'Agents'}
        >
          {menu === 'slash'
            ? slashItems.map((item, position) => (
                <button
                  key={item.name}
                  id={optionId(position)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={position === index}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(position)}
                >
                  <span className="chat-menu-command">/{item.name}</span>
                  <span>{item.description}</span>
                </button>
              ))
            : mentionItems.map((agent, position) => (
                <button
                  key={agent.id}
                  id={optionId(position)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={position === index}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(position)}
                >
                  <AgentGlyph agent={agent} size="xs" bare decorative />
                  <span className="chat-menu-command">@{agent.id}</span>
                  <span>{agent.role}</span>
                </button>
              ))}
        </div>
      )}
      {editing && confirmEdit && (
        <RewindDialog
          roomId={roomId}
          messageId={editing.messageId}
          mode="edit"
          agents={agents}
          onClose={() => setConfirmEdit(false)}
          onDone={() => {
            rewoundEdit.current = editing.messageId
            setConfirmEdit(false)
            void send()
          }}
        />
      )}
      {editing && (
        <div className="chat-editing" role="status">
          <span>Editing your message</span>
          <span className="chat-edit-note">
            Sending hides it and everything after it as the previous version.
          </span>
          <button type="button" className="chat-editing-cancel" onClick={leaveEdit}>
            Cancel
          </button>
        </div>
      )}
      {pickingWorkspace && (
        <WorkspacePicker
          agents={pickerAgents}
          onPick={addWorkspaceFile}
          onClose={() => setPickingWorkspace(false)}
        />
      )}
      <form
        className={`chat-composer-box${dragging ? ' chat-dropzone' : ''}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(event) => {
          setDragging(false)
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          void upload([...event.dataTransfer.files])
        }}
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <label className="chat-sr-only" htmlFor={`${ids}-text`}>
          Message {roomName}
        </label>
        <textarea
          id={`${ids}-text`}
          ref={textarea}
          rows={lines}
          value={text}
          placeholder="Write a message…"
          role="combobox"
          aria-expanded={menu !== null && count > 0}
          aria-controls={`${ids}-menu`}
          aria-autocomplete="list"
          aria-activedescendant={menu && count ? optionId(index) : undefined}
          onChange={(event) => edit(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // Pasted files (a screenshot, a copied document) attach; pasted text is left alone.
            const files = [...event.clipboardData.files]
            if (!files.length) return
            event.preventDefault()
            void upload(files)
          }}
        />
        {(attachments.length > 0 || uploading > 0) && (
          <ul className="chat-attachments" aria-label="Attachments">
            {attachments.map((item) => (
              <li key={attachmentKey(item)} className="chat-attachment">
                {item.kind === 'upload' && isImage(item.contentType) ? (
                  <img src={`/api/media/${encodeURIComponent(item.mediaId)}`} alt="" />
                ) : (
                  <span className="chat-attachment-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M4 1.8 H9.4 L12.6 5 V13.4 A0.8 0.8 0 0 1 11.8 14.2 H4 A0.8 0.8 0 0 1 3.2 13.4 V2.6 A0.8 0.8 0 0 1 4 1.8 Z M9.2 1.9 V5.2 H12.5"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                )}
                <span
                  title={item.kind === 'workspace' ? `${item.agentId}: ${item.path}` : undefined}
                >
                  {item.kind === 'workspace' ? item.path : attachmentName(item)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachmentName(item)}`}
                  onClick={() =>
                    setAttachments(
                      attachments.filter((other) => attachmentKey(other) !== attachmentKey(item)),
                    )
                  }
                >
                  ×
                </button>
              </li>
            ))}
            {uploading > 0 && <li className="chat-attachment">Uploading…</li>}
          </ul>
        )}
        <div className="chat-composer-row">
          <span className="chat-composer-label">To</span>
          {to.length === 0 && <span className="chat-composer-default">Room lead</span>}
          {to.map((id) => {
            const agent = agents.find((item) => item.id === id)
            const color = agent?.style.color
            return (
              <span
                key={id}
                className="chat-chip"
                style={
                  color ? { background: agentTint(color), color: agentTextColor(color) } : undefined
                }
              >
                {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
                {agent?.name ?? id}
                <button
                  type="button"
                  aria-label={`Remove ${agent?.name ?? id}`}
                  onClick={() => setTo(to.filter((item) => item !== id))}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path
                      d="M2 2 L8 8 M8 2 L2 8"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </span>
            )
          })}
          <span
            className="chat-add"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && picker) {
                event.stopPropagation()
                setPicker(false)
              }
            }}
          >
            <button
              type="button"
              className="chat-add-trigger"
              aria-expanded={picker}
              aria-haspopup="true"
              disabled={!available.length}
              onClick={() => setPicker(!picker)}
            >
              Add someone
            </button>
            {picker && (
              <ul className="chat-add-list" aria-label="Add someone">
                {available.map((agent) => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setTo([...to, agent.id])
                        setPicker(false)
                        textarea.current?.focus()
                      }}
                    >
                      <AgentGlyph agent={agent} size="xs" bare decorative />
                      {agent.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
          <span className="chat-grow" />
          <button
            type="button"
            className="chat-plan-toggle"
            aria-pressed={planFirst}
            onClick={() => setPlanFirst(!planFirst)}
          >
            <span className="chat-switch" aria-hidden="true" />
            Plan first
          </button>
          <input
            ref={fileInput}
            type="file"
            className="chat-sr-only"
            tabIndex={-1}
            aria-hidden="true"
            accept={ACCEPT}
            multiple
            data-testid="attach-input"
            onChange={(event) => void upload([...(event.target.files ?? [])])}
          />
          <span
            className="chat-attach-menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && attachMenu) {
                event.stopPropagation()
                setAttachMenu(false)
              }
            }}
          >
            <button
              type="button"
              className="chat-attach"
              aria-label="Attach files"
              aria-haspopup="true"
              aria-expanded={attachMenu}
              title="Attach images and documents (up to 10; 25 MB each)"
              disabled={pending || attachments.length + uploading >= MAX_ATTACHMENTS}
              onClick={() => setAttachMenu(!attachMenu)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M10.5 5 L5.8 9.7 A1.6 1.6 0 0 0 8.1 12 L13 7.1 A3 3 0 0 0 8.8 2.9 L3.9 7.8 A4.4 4.4 0 0 0 10.1 14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {attachMenu && (
              <ul className="chat-attach-list" aria-label="Attach">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachMenu(false)
                      fileInput.current?.click()
                    }}
                  >
                    Upload files…
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachMenu(false)
                      setPickingWorkspace(true)
                    }}
                  >
                    From workspace…
                  </button>
                </li>
              </ul>
            )}
          </span>
          {voice.supported && (
            <button
              type="button"
              className="chat-voice"
              aria-label="Voice input"
              aria-pressed={voice.listening}
              title={voice.listening ? 'Stop listening' : 'Dictate a message'}
              onClick={toggleVoice}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect
                  x="5.5"
                  y="1.5"
                  width="5"
                  height="8"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M3 7.5 A5 5 0 0 0 13 7.5 M8 12.5 V14.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
          {writing.length > 0 && !text.trim() && !editing ? (
            <button
              type="button"
              className="chat-send chat-send--stop"
              disabled={stopping}
              onClick={() => void stopReplies()}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send"
              disabled={!text.trim() || pending || uploading > 0}
            >
              {editing ? 'Send correction' : 'Send'}
            </button>
          )}
        </div>
        {voice.error && (
          <p className="chat-composer-notice chat-composer-notice--error" role="alert">
            {voice.error}
          </p>
        )}
      </form>
      {subject && meter.data && meterText(meter.data) && (
        <div className="chat-meter" aria-label={`${subjectAgent?.name ?? subject} context use`}>
          {meterFraction(meter.data) !== null && (
            <span className="chat-meter-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(meterFraction(meter.data)! * 100)}%` }} />
            </span>
          )}
          <span>
            {subjectAgent?.name ?? subject}: {meterText(meter.data)}
          </span>
        </div>
      )}
    </div>
  )
}
