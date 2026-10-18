import type { ThemeSummary } from '@score/contract'
import { setDetails } from '../../themes/customizer/draft.ts'
import { Field } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

export type ThemeSectionProps = SectionContext & {
  themes: ThemeSummary[]
  /** Replaces the draft with a copy of this theme (the caller asks first when there are unsaved changes). */
  startFrom: (id: string) => void
  exists: boolean
  /** The address is chosen from the name until the first save. */
  idFor: (name: string) => string
  source: 'new' | 'builtin' | 'imported' | 'custom'
}

export function SectionTheme({
  draft,
  edit,
  themes,
  startFrom,
  exists,
  idFor,
  source,
}: ThemeSectionProps) {
  const m = draft.manifest
  return (
    <div className="cz-section">
      <Field label="Start from" hint="Copies the look of a theme into this one">
        <select
          className="score-select cz-select"
          aria-label="Start from a theme"
          value=""
          onChange={(event) => {
            if (event.target.value) startFrom(event.target.value)
          }}
        >
          <option value="">Choose a theme…</option>
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="cz-form">
        <label>
          Name
          <input
            type="text"
            className="cz-input"
            maxLength={60}
            value={m.name}
            onChange={(event) => {
              const name = event.target.value
              edit(setDetails(draft, exists ? { name } : { name, id: idFor(name) }), 'details:name')
            }}
          />
        </label>
        <label>
          Author
          <input
            type="text"
            className="cz-input"
            maxLength={80}
            value={m.author ?? ''}
            onChange={(event) =>
              edit(setDetails(draft, { author: event.target.value }), 'details:author')
            }
          />
        </label>
        <label>
          Version
          <input
            type="text"
            className="cz-input"
            inputMode="numeric"
            placeholder="1.0.0"
            value={m.version}
            aria-describedby="cz-version-hint"
            onChange={(event) =>
              edit(setDetails(draft, { version: event.target.value }), 'details:version')
            }
          />
          <span className="cz-field-hint" id="cz-version-hint">
            Three numbers with dots, like 1.2.0.
          </span>
        </label>
        <label>
          Description
          <textarea
            className="cz-input cz-textarea"
            maxLength={400}
            rows={3}
            value={m.description ?? ''}
            onChange={(event) =>
              edit(setDetails(draft, { description: event.target.value }), 'details:description')
            }
          />
        </label>
      </div>
      <p className="cz-note">
        {exists
          ? `Saved as “${m.id}”${source === 'imported' ? ' (installed from a file)' : ''}.`
          : `It will be saved as “${m.id}”.`}
      </p>
    </div>
  )
}
