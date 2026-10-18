import { useId, useState, type ChangeEvent } from 'react'
import { builtinFontFamilies } from '../../themes/engine.ts'
import { sniffAsset, MAX_ASSET_BYTES } from '../../themes/customizer/asset-types.ts'
import {
  addFace,
  removeFace,
  setFontFamily,
  slug,
  type Face,
  type FontKey,
} from '../../themes/customizer/draft.ts'
import { Field } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

const roles: { key: FontKey; label: string; hint: string }[] = [
  { key: 'heading', label: 'Headings', hint: 'Page titles and card headings' },
  { key: 'body', label: 'Text', hint: 'Everything you read' },
  { key: 'code', label: 'Code', hint: 'Commands and file contents' },
]

const weights = [
  { value: '300', label: 'Light (300)' },
  { value: '400', label: 'Regular (400)' },
  { value: '500', label: 'Medium (500)' },
  { value: '600', label: 'Semibold (600)' },
  { value: '700', label: 'Bold (700)' },
  { value: '100 900', label: 'Variable (100–900)' },
  { value: '400 700', label: 'Variable (400–700)' },
]

const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/

export function SectionFonts({ draft, edit, announce }: SectionContext) {
  const faces = draft.manifest.fonts?.faces ?? []
  const own = [...new Set(faces.map((face) => face.family))]
  const [family, setFamily] = useState('')
  const [weight, setWeight] = useState('400')
  const [style, setStyle] = useState<'normal' | 'italic'>('normal')
  const [problem, setProblem] = useState('')
  const [fileKey, setFileKey] = useState(0)
  const familyId = useId()

  async function add(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setProblem('')
    if (!FAMILY.test(family.trim())) {
      setProblem('Give the font a name first: letters, numbers, spaces, dashes or underscores.')
      setFileKey((n) => n + 1)
      return
    }
    if (file.size > MAX_ASSET_BYTES) {
      setProblem('That font file is larger than 8 MB.')
      setFileKey((n) => n + 1)
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (sniffAsset(bytes) !== 'woff2') {
      setProblem('That isn’t a woff2 font file. Convert it to woff2 first.')
      setFileKey((n) => n + 1)
      return
    }
    if (faces.length >= 12) {
      setProblem('A theme can carry up to 12 font files.')
      setFileKey((n) => n + 1)
      return
    }
    const name = family.trim()
    const path = `fonts/${slug(name, 'font')}-${weight.replace(' ', '-')}-${style}.woff2`
    const face: Face = { family: name, src: `asset:${path}`, weight, style }
    edit(addFace(draft, face, bytes))
    announce(`Added ${name}, ${weight}.`)
    setFamily('')
    setFileKey((n) => n + 1)
  }

  return (
    <div className="cz-section">
      <p className="cz-note">
        Pick a font for each job. Your own font files (woff2) can be added below and then chosen
        here.
      </p>
      {roles.map(({ key, label, hint }) => {
        const value = draft.manifest.fonts?.[key] ?? ''
        const sample =
          key === 'heading'
            ? 'Plan the week'
            : key === 'body'
              ? 'The agents have answered two questions and are waiting on your approval.'
              : 'pnpm check'
        return (
          <Field key={key} label={label} hint={hint}>
            <select
              className="score-select cz-select"
              aria-label={`${label} font`}
              value={value}
              onChange={(event) => edit(setFontFamily(draft, key, event.target.value || undefined))}
            >
              <option value="">Score’s font</option>
              <optgroup label="Built in">
                {builtinFontFamilies.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
              {own.length > 0 && (
                <optgroup label="Your fonts">
                  {own.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span className="cz-font-sample" data-role={key} aria-hidden="true">
              {sample}
            </span>
          </Field>
        )
      })}

      <fieldset className="cz-group">
        <legend>Your font files</legend>
        {faces.length === 0 && <p className="cz-note">No font files added yet.</p>}
        <ul className="cz-faces">
          {faces.map((face) => (
            <li key={face.src}>
              <span>
                <strong>{face.family}</strong> · {face.weight} · {face.style}
              </span>
              <button
                type="button"
                className="cz-link"
                aria-label={`Remove ${face.family} ${face.weight} ${face.style}`}
                onClick={() => {
                  edit(removeFace(draft, face.src))
                  announce(`Removed ${face.family}.`)
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="cz-add-font">
          <label htmlFor={familyId}>Font name</label>
          <input
            id={familyId}
            type="text"
            className="cz-input"
            maxLength={60}
            value={family}
            placeholder="Brand Sans"
            onChange={(event) => setFamily(event.target.value)}
          />
          <label>
            Weight
            <select
              className="score-select cz-select"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
            >
              {weights.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Style
            <select
              className="score-select cz-select"
              value={style}
              onChange={(event) => setStyle(event.target.value as 'normal' | 'italic')}
            >
              <option value="normal">Normal</option>
              <option value="italic">Italic</option>
            </select>
          </label>
          <label className="cz-file">
            Add a woff2 file
            <input
              key={fileKey}
              type="file"
              accept=".woff2,font/woff2"
              onChange={(event) => void add(event)}
            />
          </label>
        </div>
        {problem && (
          <p className="cz-problem" role="alert">
            {problem}
          </p>
        )}
      </fieldset>
    </div>
  )
}
