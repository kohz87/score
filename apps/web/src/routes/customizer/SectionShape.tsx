import { setChat, setShape } from '../../themes/customizer/draft.ts'
import { Field, OptionalSegmented, Slider } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

type Radius = 'sharp' | 'soft' | 'round' | 'custom'

export function SectionShape({ draft, edit }: SectionContext) {
  const shape = draft.manifest.shape ?? {}
  const radius = shape.radius
  const radiusChoice: Radius | undefined = typeof radius === 'number' ? 'custom' : radius
  return (
    <div className="cz-section">
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
      <Field label="Borders" hint="The lines around cards">
        <OptionalSegmented
          label="Borders"
          value={shape.border}
          options={[
            { value: 'none', label: 'None' },
            { value: 'hairline', label: 'Thin' },
            { value: 'strong', label: 'Strong' },
          ]}
          onChange={(next) => edit(setShape(draft, 'border', next))}
        />
      </Field>
      <Field label="Shadows" hint="Whether cards sit on the page or float above it">
        <OptionalSegmented
          label="Shadows"
          value={shape.elevation}
          options={[
            { value: 'flat', label: 'Flat' },
            { value: 'raised', label: 'Raised' },
            { value: 'floating', label: 'Floating' },
          ]}
          onChange={(next) => edit(setShape(draft, 'elevation', next))}
        />
      </Field>
      <Field label="Card surface" hint="Glass lets the page background show through cards">
        <OptionalSegmented
          label="Card surface"
          value={shape.surface}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'glass', label: 'Glass' },
          ]}
          onChange={(next) => edit(setShape(draft, 'surface', next))}
        />
      </Field>
    </div>
  )
}

export function SectionChat({ draft, edit }: SectionContext) {
  const chat = draft.manifest.layout?.chat ?? {}
  return (
    <div className="cz-section">
      <Field label="Messages" hint="Plain lines, or speech bubbles with yours on the right">
        <OptionalSegmented
          label="Messages"
          value={chat.messages}
          options={[
            { value: 'plain', label: 'Plain' },
            { value: 'bubbles', label: 'Bubbles' },
          ]}
          onChange={(next) => edit(setChat(draft, 'messages', next))}
        />
      </Field>
      <Field label="Room list" hint="Where the list of rooms sits in Chat">
        <OptionalSegmented
          label="Room list"
          value={chat.roomList}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
            { value: 'hidden-until-opened', label: 'Hidden' },
          ]}
          onChange={(next) => edit(setChat(draft, 'roomList', next))}
        />
      </Field>
    </div>
  )
}
