import { setShape } from '../../themes/customizer/draft.ts'
import { Field, OptionalSegmented, Slider } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

type Radius = 'sharp' | 'soft' | 'round' | 'custom'

// Decision 131 E: the classic Layout tab (menu rail, menu order, page width, chat room list) is gone with the classic
// shell; what is left of it is how much room things get and how round they are.
export function SectionSpacing({ draft, edit }: SectionContext) {
  const shape = draft.manifest.shape ?? {}
  const radius = shape.radius
  const radiusChoice: Radius | undefined = typeof radius === 'number' ? 'custom' : radius
  return (
    <div className="cz-section">
      <Field label="Spacing" hint="How much room there is between things">
        <OptionalSegmented
          label="Spacing"
          value={shape.density}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'airy', label: 'Airy' },
          ]}
          onChange={(next) => edit(setShape(draft, 'density', next))}
        />
      </Field>
      <Field label="Corners" hint="How round cards, buttons and fields are">
        <OptionalSegmented
          label="Corners"
          value={radiusChoice}
          options={[
            { value: 'sharp', label: 'Sharp' },
            { value: 'soft', label: 'Soft' },
            { value: 'round', label: 'Round' },
            { value: 'custom', label: 'Exact' },
          ]}
          onChange={(next) => edit(setShape(draft, 'radius', next === 'custom' ? 16 : next))}
        />
        {typeof radius === 'number' && (
          <Slider
            label="Corner size"
            value={radius}
            min={0}
            max={40}
            unit=" px"
            onChange={(value) => edit(setShape(draft, 'radius', value), 'shape:radius')}
          />
        )}
      </Field>
    </div>
  )
}
