import { AgentStylePatchSchema, AgentSummarySchema, type AgentSummary } from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { AgentAvatar } from '../../components/AgentAvatar.tsx'
import { activityOfStatus } from '../../components/agent-activity.ts'
import { apiFetch, ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { AgentAppearanceFields, type AppearanceValue } from './AgentAppearanceFields.tsx'
import { PetPackSection } from './PetPackSection.tsx'

export function AgentStylePicker({ agent }: { agent: AgentSummary }) {
  const [open, setOpen] = useState(false)
  const current = (): AppearanceValue => ({
    color: agent.style.color,
    shape: agent.style.shape,
    look: agent.style.look ?? 'cut',
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
        className={`team-glyph-trigger${agent.style.pack ? ' team-glyph-trigger--pet' : ''}`}
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
        <AgentAvatar
          agent={agent}
          size="lg"
          bare
          decorative
          contrast="high"
          activity={activityOfStatus(agent.status)}
          petClassName="team-pet-trigger"
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
          <PetPackSection agent={agent} />
        </div>
      )}
    </div>
  )
}
