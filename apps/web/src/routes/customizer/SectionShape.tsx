import { setShape } from '../../themes/customizer/draft.ts'
import { Field, OptionalSegmented } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

export function SectionShape({ draft, edit }: SectionContext) {
  const shape = draft.manifest.shape ?? {}
  return (
    <div className="cz-section">
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
