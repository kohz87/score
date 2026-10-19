import { AgentStylePatchSchema, AgentSummarySchema, type AgentSummary } from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { activityOfStatus } from '../../components/agent-activity.ts'
import { apiFetch, ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { AgentAppearanceFields, type AppearanceValue } from './AgentAppearanceFields.tsx'

// What the server accepts (PUT /api/agents/:id/avatar); checked here first so a wrong file fails without an upload.
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const PICTURE_MAX_BYTES = 2 * 1024 * 1024

function rejection(error: unknown): string[] {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return ['Pair this browser using the link in the server terminal to change agent pictures.']
    const reasons = (error.details as { reasons?: unknown } | undefined)?.reasons
    if (Array.isArray(reasons) && reasons.every((reason) => typeof reason === 'string'))
      return reasons.length > 0 ? (reasons as string[]) : [error.message]
    return [error.message]
  }
  return ['Couldn’t save the picture. Try again.']
}

function AgentPicture({ agent }: { agent: AgentSummary }) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  useEffect(() => {
    if (!file) return setPreviewUrl(null)
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  const base = `agents/${encodeURIComponent(agent.id)}/avatar`
  const upload = useMutation({
    mutationFn: async (picture: File) => {
      const form = new FormData()
      form.append('file', picture, picture.name)
      return AgentSummarySchema.parse(
        await apiFetch(base, {
          method: 'PUT',
          headers: { 'Idempotency-Key': newId() },
          body: form,
        }),
      )
    },
    onSuccess: () => {
      setFile(null)
      setProblems([])
    },
    onError: (error) => setProblems(rejection(error)),
  })
  const remove = useMutation({
    mutationFn: async () =>
      AgentSummarySchema.parse(
        await apiFetch(base, { method: 'DELETE', headers: { 'Idempotency-Key': newId() } }),
      ),
    onSuccess: () => setProblems([]),
    onError: (error) => setProblems(rejection(error)),
  })
  function choose(picture: File | undefined) {
    upload.reset()
    if (!picture) return setFile(null)
    if (!PICTURE_TYPES.includes(picture.type)) {
      setFile(null)
      return setProblems(['Choose a PNG, JPEG or WebP picture.'])
    }
    if (picture.size > PICTURE_MAX_BYTES) {
      setFile(null)
      return setProblems(['The picture is larger than 2 MB.'])
    }
    setProblems([])
    setFile(picture)
  }
  const busy = upload.isPending || remove.isPending
  return (
    <section className="team-picture" aria-label="Picture">
      <h3>Picture</h3>
      <p className="team-muted">
        Use your own picture instead of the bot or chibi. Score moves it for you. PNG, JPEG or WebP,
        up to 2 MB.
      </p>
      <input
        ref={input}
        className="team-picture-input"
        type="file"
        accept={PICTURE_TYPES.join(',')}
        aria-label="Picture file"
        tabIndex={-1}
        onChange={(event) => {
          choose(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      {previewUrl && file && (
        <div className="team-picture-preview">
          <img src={previewUrl} alt={`Preview of ${file.name}`} />
          <span>{file.name}</span>
        </div>
      )}
      <div className="team-style-actions">
        {file ? (
          <>
            <button
              type="button"
              className="team-primary"
              disabled={busy}
              onClick={() => upload.mutate(file)}
            >
              {upload.isPending ? 'Uploading…' : 'Use this picture'}
            </button>
            <button type="button" disabled={busy} onClick={() => choose(undefined)}>
              Cancel picture
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>
            {agent.style.avatar ? 'Replace picture…' : 'Use a picture…'}
          </button>
        )}
        {agent.style.avatar && !file && (
          <button type="button" disabled={busy} onClick={() => remove.mutate()}>
            {remove.isPending ? 'Removing…' : 'Remove picture'}
          </button>
        )}
      </div>
      {problems.length > 0 && (
        <ul role="alert" className="team-picture-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function AgentStylePicker({ agent }: { agent: AgentSummary }) {
  const [open, setOpen] = useState(false)
  const current = (): AppearanceValue => ({
    color: agent.style.color,
    shape: agent.style.shape,
    look: agent.style.look ?? 'bot',
  })
  const [value, setValue] = useState<AppearanceValue>(current)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const mutation = useMutation({
    mutationFn: async () => {
      const style = AgentStylePatchSchema.parse(value)
      return AgentSummarySchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agent.id)}/style`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify(style),
        }),
      )
    },
    onSuccess: close,
  })
  function close() {
    setOpen(false)
    trigger.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    popover.current?.querySelector<HTMLInputElement>('input[type="color"]')?.focus()
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !popover.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])
  return (
    <div className="team-style" ref={popover}>
      <button
        className="team-glyph-trigger"
        ref={trigger}
        type="button"
        aria-label={`Change ${agent.name}’s look, colour and shape`}
        aria-expanded={open}
        aria-controls="agent-style-picker"
        onClick={() => {
          if (open) close()
          else {
            setValue(current())
            mutation.reset()
            setOpen(true)
          }
        }}
      >
        <AgentGlyph
          agent={agent}
          size="lg"
          bare
          decorative
          contrast="high"
          activity={activityOfStatus(agent.status)}
        />
      </button>
      {open && (
        <div
          id="agent-style-picker"
          className="team-style-popover"
          role="dialog"
          aria-label="Agent appearance"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              close()
            }
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              mutation.mutate()
            }}
          >
            <h2>Agent appearance</h2>
            <AgentAppearanceFields
              value={value}
              onChange={setValue}
              preview={{ id: agent.id, name: agent.name }}
            />
            {mutation.isError && (
              <p role="alert">
                {mutation.error instanceof ApiError && mutation.error.code === 'not_paired'
                  ? 'Pair this browser using the link in the server terminal to change agent appearance.'
                  : 'Couldn’t save appearance. Try again.'}
              </p>
            )}
            <div className="team-style-actions">
              <button type="submit" className="team-primary" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Save appearance'}
              </button>
              <button type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </form>
          <AgentPicture agent={agent} />
        </div>
      )}
    </div>
  )
}
