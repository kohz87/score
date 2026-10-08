import {
  AgentStyleSchema,
  AgentSummarySchema,
  ShapeSchema,
  type AgentSummary,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'

export function AgentStylePicker({ agent }: { agent: AgentSummary }) {
  const [open, setOpen] = useState(false)
  const [color, setColor] = useState(agent.style.color)
  const [shape, setShape] = useState(agent.style.shape)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const colorInput = useRef<HTMLInputElement>(null)
  const mutation = useMutation({
    mutationFn: async () => {
      const style = AgentStyleSchema.parse({ color, shape })
      return AgentSummarySchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agent.id)}/style`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
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
    colorInput.current?.focus()
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
        aria-label={`Change ${agent.name}'s color and shape`}
        aria-expanded={open}
        aria-controls="agent-style-picker"
        onClick={() => {
          if (open) close()
          else {
            setColor(agent.style.color)
            setShape(agent.style.shape)
            mutation.reset()
            setOpen(true)
          }
        }}
      >
        <AgentGlyph agent={agent} bare decorative contrast="high" />
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
            <label>
              Color
              <input
                ref={colorInput}
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
              />
            </label>
            <label>
              Shape
              <select
                value={shape}
                onChange={(event) => setShape(ShapeSchema.parse(event.target.value))}
              >
                {ShapeSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {option.replace('-', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <AgentGlyph
              agent={{ ...agent, style: { color, shape } }}
              describeShape
              contrast="high"
            />
            {mutation.isError && (
              <p role="alert">
                {mutation.error instanceof ApiError && mutation.error.code === 'not_paired'
                  ? 'Pair this browser using the link in the server terminal to change agent appearance.'
                  : 'Could not save appearance. Please try again.'}
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
        </div>
      )}
    </div>
  )
}
