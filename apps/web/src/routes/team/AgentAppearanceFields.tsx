import { ShapeSchema, type Shape } from '@score/contract'
import { useId } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'

/** What the Add, Import and agent-page forms let a person choose
 */
export type AppearanceValue = { color: string; shape: Shape }

export function shapeLabel(shape: Shape) {
  return shape.replace('-', ' ')
}

/**
 * Colour and shape for one agent: a colour input and a radio group of the twenty shapes. Native radios, so Tab enters a group and the arrow keys move through it. Each choice shows what it
 * looks like in the colour chosen so far.
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
        <AgentGlyph agent={{ ...preview, style: value }} size="lg" describeShape contrast="high" />
      </div>
      <label className="team-appearance-colour">
        Colour
        <input
          type="color"
          value={value.color}
          onChange={(event) => onChange({ ...value, color: event.target.value })}
        />
      </label>
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
              <AgentGlyph agent={{ ...preview, style: { ...value, shape } }} size="sm" decorative />
              <span className="team-shape-name">{shapeLabel(shape)}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
