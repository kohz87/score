import {
  AgentSummarySchema,
  AvatarEyesSchema,
  type AgentSummary,
  type AvatarEyes,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { AgentGlyph, agentAvatarUrl } from '../../components/AgentGlyph.tsx'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { avatarProblems } from './avatar-errors.ts'
import { defaultEyes, moveBox, resizeBox, sampleLid, type EyeSide } from './eye-marks.ts'
import './agent-eyes.css'

type Boxes = Pick<AvatarEyes, 'left' | 'right'>
type Drag = {
  side: EyeSide
  mode: 'move' | 'resize'
  x: number
  y: number
  box: Boxes[EyeSide]
  width: number
  height: number
}

const SAMPLE_SIDE = 512
const labels: Record<EyeSide, string> = { left: 'Left eye', right: 'Right eye' }

/** The picture's pixels, scaled down so the lid colour is cheap to sample; null when a canvas can't be had. */
function readPixels(image: HTMLImageElement) {
  try {
    const scale = Math.min(1, SAMPLE_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0, width, height)
    return context.getImageData(0, 0, width, height)
  } catch {
    return null
  }
}

/**
 * The step after "Use this picture" (decision 106): the picture large, two boxes to put over its eyes (drag, drag the
 * corner, or the keyboard), a live blink preview and Save / Skip. The eyelid colour is sampled from the picture just
 * under each box, so what blinks is the picture's own skin.
 */
export function AgentEyeMarker({
  agent,
  start,
  onDone,
}: {
  agent: AgentSummary
  /** The marks to start from (editing existing ones), else the default boxes. */
  start?: AvatarEyes | null
  onDone: () => void
}) {
  const hint = useId()
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [boxes, setBoxes] = useState<Boxes>(
    start ? { left: start.left, right: start.right } : defaultEyes,
  )
  const [pixels, setPixels] = useState<ImageData | null>(null)
  const [closed, setClosed] = useState(false)
  const blink = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(blink.current), [])
  const lid = useMemo(
    () => sampleLid(pixels ?? { width: 0, height: 0, data: [] }, [boxes.left, boxes.right]),
    [pixels, boxes],
  )
  const marks: AvatarEyes = { ...boxes, lid }
  const avatar = agent.style.avatar ?? ''
  const save = useMutation({
    mutationFn: async () =>
      AgentSummarySchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agent.id)}/avatar/eyes`, {
          method: 'PUT',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify(AvatarEyesSchema.parse(marks)),
        }),
      ),
    onSuccess: onDone,
  })

  const change = (side: EyeSide, next: Boxes[EyeSide]) =>
    setBoxes((current) => ({ ...current, [side]: next }))

  function begin(event: PointerEvent<HTMLElement>, side: EyeSide, mode: Drag['mode']) {
    const rect = stage.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = {
      side,
      mode,
      x: event.clientX,
      y: event.clientY,
      box: boxes[side],
      width: rect.width,
      height: rect.height,
    }
  }
  function dragging(event: PointerEvent<HTMLElement>) {
    const current = drag.current
    if (!current) return
    const dx = (event.clientX - current.x) / current.width
    const dy = (event.clientY - current.y) / current.height
    change(
      current.side,
      current.mode === 'move' ? moveBox(current.box, dx, dy) : resizeBox(current.box, dx, dy),
    )
  }
  const end = () => {
    drag.current = null
  }
  function keys(event: KeyboardEvent<HTMLElement>, side: EyeSide) {
    const step = event.shiftKey ? 0.05 : 0.01
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const move = delta[event.key]
    if (!move) return
    event.preventDefault()
    change(
      side,
      event.altKey
        ? resizeBox(boxes[side], move[0], move[1])
        : moveBox(boxes[side], move[0], move[1]),
    )
  }
  function blinkOnce() {
    clearTimeout(blink.current)
    setClosed(true)
    blink.current = setTimeout(() => setClosed(false), 450)
  }

  return (
    <section className="team-eyes" aria-label="Mark the eyes">
      <h3>Mark the eyes</h3>
      <p id={hint} className="team-muted">
        Put a box over each eye so Score can blink them: drag a box, and drag its corner to resize
        it. With the keyboard, the arrow keys move the focused box and Alt with the arrow keys
        resizes it. Skip if the picture has no eyes to blink.
      </p>
      <div className="team-eyes-stage" ref={stage}>
        <img
          src={agentAvatarUrl(agent.id, avatar)}
          alt="Your picture, to mark its eyes on"
          draggable={false}
          onLoad={(event) => setPixels(readPixels(event.currentTarget))}
        />
        {(['left', 'right'] as const).map((side) => {
          const box = boxes[side]
          return (
            <div
              key={side}
              className={`team-eye-box team-eye-box--${side}`}
              role="group"
              aria-label={labels[side]}
              aria-describedby={hint}
              tabIndex={0}
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.w * 100}%`,
                height: `${box.h * 100}%`,
              }}
              onPointerDown={(event) => begin(event, side, 'move')}
              onPointerMove={dragging}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={(event) => keys(event, side)}
            >
              <span className="team-eye-name" aria-hidden="true">
                {side === 'left' ? 'L' : 'R'}
              </span>
              <span
                className="team-eye-handle"
                aria-hidden="true"
                onPointerDown={(event) => begin(event, side, 'resize')}
                onPointerMove={dragging}
                onPointerUp={end}
                onPointerCancel={end}
              />
            </div>
          )
        })}
      </div>
      <div className="team-eyes-preview">
        <AgentGlyph
          agent={{ ...agent, style: { ...agent.style, avatarEyes: marks } }}
          size="lg"
          decorative
          asleep={closed}
        />
        <div className="team-eyes-lid">
          <span className="team-eyes-swatch" style={{ background: lid }} aria-hidden="true" />
          <span>
            Eyelid colour <code>{lid}</code>
          </span>
        </div>
        <button type="button" onClick={blinkOnce}>
          Blink
        </button>
      </div>
      {save.isError && (
        <ul role="alert" className="team-picture-problems">
          {avatarProblems(save.error, 'Couldn’t save the eye marks. Try again.').map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="team-style-actions">
        <button
          type="button"
          className="team-primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save eyes'}
        </button>
        <button type="button" disabled={save.isPending} onClick={onDone}>
          Skip
        </button>
      </div>
    </section>
  )
}
