import { useEffect, useRef, type CSSProperties } from 'react'
import type { Shape } from '@score/contract'
import { followPointer } from './agent-face-pointer.ts'
import { ARC_STROKE, faceGeometry, faceTiming, type FaceMood } from './agent-face.ts'
import './agent-face.css'

/**
 * The eyes of one agent glyph (decision 127), drawn inside the glyph's own 20-unit svg. Motion is CSS only (keyframes
 * with a per-agent delay from a hash of the id); the one piece of script is the pointer follow of a `lively` hero.
 */
export function AgentFace({
  id,
  shape,
  mood,
  animated,
  lively,
}: {
  id: string
  shape: Shape
  mood: FaceMood
  animated: boolean
  lively: boolean
}) {
  const geometry = faceGeometry(shape, mood)
  const { lx, ly } = geometry.layout
  const timing = faceTiming(id)
  const ref = useRef<SVGGElement>(null)
  useEffect(() => {
    if (!lively || !animated || mood !== 'idle' || !ref.current) return
    return followPointer(ref.current, lx, ly)
  }, [lively, animated, mood, lx, ly])

  const style = {
    '--lx': lx,
    '--ly': ly,
    '--face-look': `${timing.look}s`,
    '--face-blink': `${timing.blink}s`,
    '--face-delay': `${timing.delay.toFixed(2)}s`,
    '--face-delay2': `${timing.delay2.toFixed(2)}s`,
  } as CSSProperties

  return (
    <g
      ref={ref}
      className={`agent-face agent-face--${mood}${animated ? ' agent-face--animated' : ''}`}
      style={style}
      aria-hidden="true"
    >
      {mood === 'done' ? (
        <g className="agent-face__arcs">
          {/* A hair of the agent's darker shade under each white arc, as the sockets have, for pale agents. */}
          {geometry.arcs.map((d, index) => (
            <path
              key={`edge${index}`}
              d={d}
              className="agent-face__arc-edge"
              strokeWidth={ARC_STROKE + 0.6}
            />
          ))}
          {geometry.arcs.map((d, index) => (
            <path key={index} d={d} className="agent-face__arc" strokeWidth={ARC_STROKE} />
          ))}
        </g>
      ) : (
        <g className="agent-face__gaze">
          {geometry.eyes.map((eye, index) => (
            <g key={index} transform={`translate(${eye.x} ${eye.y})`}>
              <g transform={`rotate(${eye.tilt})`}>
                <path d={eye.d} className="agent-face__socket" />
              </g>
            </g>
          ))}
        </g>
      )}
    </g>
  )
}
