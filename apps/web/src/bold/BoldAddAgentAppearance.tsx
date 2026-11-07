import { ShapeSchema, type AgentStyle, type AgentSummary } from '@score/contract'
import { useEffect, useId } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { shapeLabel } from '../routes/team/AgentAppearanceFields.tsx'
import { colourChoices } from './bold-add-agent.ts'

/** Shape, colour and the live mark: the same 22 contract shapes, with colours already on the team faded. */
export function Appearance({
  agents,
  name,
  value,
  onChange,
}: {
  agents: AgentSummary[]
  name: string
  value: AgentStyle
  onChange: (style: AgentStyle) => void
}) {
  const colours = colourChoices(agents)
  const chosen = colours.find((choice) => choice.colour === value.color.toLowerCase())
  const firstFree = colours.find((choice) => choice.takenBy === null)
  useEffect(() => {
    // The dialog can open before the roster has loaded; once it does, never keep a colour that is already taken.
    if (firstFree && (!chosen || chosen.takenBy !== null))
      onChange({ ...value, color: firstFree.colour })
  }, [chosen, firstFree, onChange, value])
  const group = useId()
  return (
    <div className="bold-add-appearance">
      <div className="bold-add-preview">
        <AgentGlyph
          agent={{ id: 'new-agent', name: name || 'New agent', style: value }}
          size="lg"
          lively
          describeShape
        />
      </div>
      <div className="bold-add-shapes" role="radiogroup" aria-label="Shape">
        {ShapeSchema.options.map((shape) => {
          const selected = value.shape === shape
          const label = shapeLabel(shape)
          return (
            <label key={shape} className={selected ? 'on' : undefined}>
              <input
                type="radio"
                name={`${group}-shape`}
                value={shape}
                checked={selected}
                aria-label={label}
                onChange={() => onChange({ ...value, shape })}
              />
              <AgentGlyph
                agent={{ id: `shape-${shape}`, name: label, style: { ...value, shape } }}
                size="sm"
                bare
                decorative
              />
            </label>
          )
        })}
      </div>
      <div className="bold-add-colours" role="radiogroup" aria-label="Colour">
        {colours.map(({ colour, takenBy }) => {
          const selected = value.color.toLowerCase() === colour
          return (
            <label
              key={colour}
              className={selected ? 'on' : undefined}
              style={{ background: colour }}
            >
              <input
                type="radio"
                name={`${group}-colour`}
                value={colour}
                checked={selected}
                aria-label={`Colour ${colour}${takenBy ? `, used by ${takenBy}` : ''}`}
                data-colour={colour}
                disabled={takenBy !== null}
                onChange={() => onChange({ ...value, color: colour })}
              />
            </label>
          )
        })}
      </div>
      <span className="bold-add-hint">22 shapes · Faded colours are taken</span>
    </div>
  )
}
