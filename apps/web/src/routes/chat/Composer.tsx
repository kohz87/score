import type { AgentSummary } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
import { messagesQuery, type MessagePageData } from './queries.ts'

type Notice = { kind: 'error'; text: string } | { kind: 'result'; command: CommandResult | null }
type Attachment = { mediaId: string; name: string }
function parseUpload(value: unknown): Attachment {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  if (typeof record.mediaId !== 'string' || !record.mediaId) throw new Error('Bad upload response')
  return { mediaId: record.mediaId, name: typeof record.name === 'string' ? record.name : 'image' }
}
type Snapshot = { asOfSeq: number; data: MessagePageData }

function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not send the message. Please try again.'
  const details =
    typeof error.details === 'object' && error.details !== null
      ? (error.details as { error?: unknown; usage?: unknown })
      : {}
  const reason = typeof details.error === 'string' ? details.error : null
  const usage = typeof details.usage === 'string' ? `Usage: ${details.usage}` : null
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
}: {
  roomId: string
  roomName: string
  agents: AgentSummary[]
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
  const fileInput = useRef<HTMLInputElement>(null)

  const commands = useQuery({
    queryKey: ['chat', 'commands'],
    queryFn: async () => parseCommands(await apiFetch('commands')),
    staleTime: Infinity,
  })

  useEffect(() => saveDraft(roomId, text), [roomId, text])

  const slash = slashQuery(text)
  const mention = slash === null ? mentionAt(text, caret) : null
  const slashItems: SlashCommand[] = useMemo(
    () =>
      slash === null ? [] : (commands.data ?? []).filter((item) => item.name.startsWith(slash)),
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

  async function upload(files: FileList | null) {
    const picked = [...(files ?? [])]
    if (fileInput.current) fileInput.current.value = ''
    for (const file of picked) {
      setUploading((count) => count + 1)
      try {
        const form = new FormData()
        form.append('file', file, file.name)
        const stored = parseUpload(await apiFetch('media', { method: 'POST', body: form }))
        setAttachments((current) =>
          current.length >= 8
            ? current
            : [...current, { mediaId: stored.mediaId, name: stored.name }],
        )
      } catch (error) {
        const reason =
          error instanceof ApiError && error.status === 413
            ? 'is larger than 8 MB'
            : error instanceof ApiError && error.status === 415
              ? 'is not a PNG, JPEG, WebP or GIF image'
              : 'could not be uploaded'
        setNotice({ kind: 'error', text: `${file.name} ${reason}.` })
      } finally {
        setUploading((count) => count - 1)
      }
    }
  }

  async function send() {
    const body = text.trim()
    if (!body || pending || uploading) return
    const sent = attachments
    const payload = {
      text: body,
      ...(sent.length ? { attachments: sent.map(({ mediaId }) => ({ mediaId })) } : {}),
      ...(to.length ? { to } : {}),
      ...(planFirst ? { planFirst: true } : {}),
    }
    // A retry of the same payload reuses its key, so a lost response cannot post twice.
    const signature = JSON.stringify(payload)
    if (sendKey.current?.signature !== signature)
      sendKey.current = { signature, key: crypto.randomUUID() }
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
        parts: [
          { kind: 'text', text: body },
          ...sent.map(({ mediaId }) => ({ kind: 'image' as const, mediaId })),
        ],
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
      setText('')
      setCaret(0)
      setAttachments([])
      setNotice({ kind: 'result', command: result.command })
    } catch (error) {
      update((data) => withoutMessage(data, temporary))
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setPending(false)
      textarea.current?.focus()
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const available = agents.filter((agent) => !to.includes(agent.id))
  const lines = Math.min(Math.max(text.split('\n').length, 1), 8)
  return (
    <div className="chat-composer">
      {notice && (
        <div
          className={`chat-composer-notice${notice.kind === 'error' ? ' chat-composer-notice--error' : ''}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.kind === 'error' ? notice.text : <CommandNotice command={notice.command} />}
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
      <form
        className="chat-composer-box"
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
        />
        {(attachments.length > 0 || uploading > 0) && (
          <ul className="chat-attachments" aria-label="Attachments">
            {attachments.map((item) => (
              <li key={item.mediaId} className="chat-attachment">
                <img src={`/api/media/${encodeURIComponent(item.mediaId)}`} alt="" />
                <span>{item.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  onClick={() =>
                    setAttachments(attachments.filter(({ mediaId }) => mediaId !== item.mediaId))
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
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            data-testid="attach-input"
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            className="chat-attach"
            aria-label="Attach files"
            title="Attach images (PNG, JPEG, WebP, GIF; up to 8 MB)"
            disabled={pending || attachments.length >= 8}
            onClick={() => fileInput.current?.click()}
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
          <button
            type="submit"
            className="chat-send"
            disabled={!text.trim() || pending || uploading > 0}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  )
}
