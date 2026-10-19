import { ShapeSchema, type AgentLook, type Shape } from '@score/contract'
import { useId } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'

/** What the Add, Import and agent-page forms let a person choose; a picture has its own control (AgentPicture). */
export type AppearanceValue = { color: string; shape: Shape; look: AgentLook }

const looks: { value: AgentLook; label: string; hint: string }[] = [
  { value: 'cut', label: 'Cut-out', hint: 'A solid mark; the eyes are cut through it' },
  { value: 'ring', label: 'Ring', hint: 'The shape as one thick outline' },
]

export function shapeLabel(shape: Shape) {
  return shape.replace('-', ' ')
}

/**
 * Look (cut-out or ring), colour and shape for one agent: a radio group of the two looks and a radio group of the
 * twenty shapes. Native radios, so Tab enters a group and the arrow keys move through it. Each choice shows what it
 * looks like with the colour and look chosen so far.
 */
export function AgentAppearanceFields({
  value,
  onChange,
  preview,
}: {
  value: AppearanceValue
  onChange: (value: AppearanceValue) => void
  /** The agent as drawn in the big preview. */
  preview: { id: string; name: string }
}) {
  const group = useId()
  return (
    <div className="team-appearance">
      <div className="team-appearance-preview">
        <AgentGlyph
          agent={{ ...preview, style: value }}
          size="lg"
          describeShape
          contrast="high"
          activity="idle"
        />
      </div>
      <label className="team-appearance-colour">
        Colour
        <input
          type="color"
          value={value.color}
          onChange={(event) => onChange({ ...value, color: event.target.value })}
        />
      </label>
      <div role="radiogroup" aria-label="Look" className="team-looks">
        {looks.map((look) => (
          <label key={look.value} className="team-look-choice">
            <input
              type="radio"
              name={`${group}-look`}
              value={look.value}
              checked={value.look === look.value}
              onChange={() => onChange({ ...value, look: look.value })}
            />
            <span className="team-look-card">
              <AgentGlyph
                agent={{ ...preview, style: { ...value, look: look.value } }}
                size="md"
                decorative
                activity="idle"
              />
              <span className="team-look-name">{look.label}</span>
            </span>
          </label>
        ))}
      </div>
      <div role="radiogroup" aria-label="Shape" className="team-shapes">
        {ShapeSchema.options.map((shape) => (
          <label key={shape} className="team-shape-choice">
            <input
              type="radio"
              name={`${group}-shape`}
              value={shape}
              checked={value.shape === shape}
              onChange={() => onChange({ ...value, shape })}
            />
            <span className="team-shape-cell">
              <AgentGlyph
                agent={{ ...preview, style: { ...value, shape } }}
                size="sm"
                decorative
                plain
              />
              <span className="team-shape-name">{shapeLabel(shape)}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
