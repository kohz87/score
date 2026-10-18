import { useState, type ChangeEvent } from 'react'
import { MAX_ASSET_BYTES, sniffAsset } from '../../themes/customizer/asset-types.ts'
import {
  clearBackground,
  setBackgroundDim,
  setBackgroundFit,
  setBackgroundImage,
} from '../../themes/customizer/draft.ts'
import { Field, Segmented, Slider } from './controls.tsx'
import type { SectionContext } from './section-context.ts'

export function SectionBackground({ draft, edit, resolve, announce }: SectionContext) {
  const background = draft.manifest.background
  const [problem, setProblem] = useState('')
  const [key, setKey] = useState(0)
  const url = background?.image ? resolve(background.image) : null

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setProblem('')
    setKey((n) => n + 1)
    if (file.size > MAX_ASSET_BYTES) {
      setProblem('That picture is larger than 8 MB.')
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const kind = sniffAsset(bytes)
    if (!kind || kind === 'woff2') {
      setProblem('Use a PNG, JPG, WebP or AVIF picture.')
      return
    }
    edit(setBackgroundImage(draft, `asset:img/background.${kind}`, bytes))
    announce('Background picture added.')
  }

  return (
    <div className="cz-section">
      <p className="cz-note">
        A picture behind the whole app. Cards stay readable on top of it; use Dim to calm a busy
        picture, and Glass cards in Shape to let it show through.
      </p>
      <Field label="Picture" hint="PNG, JPG, WebP or AVIF, up to 8 MB">
        {url && <img className="cz-bg-thumb" src={url} alt="The chosen background picture" />}
        <div className="cz-row">
          <label className="cz-file">
            {background?.image ? 'Choose another picture' : 'Choose a picture'}
            <input
              key={key}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.avif,image/png,image/jpeg,image/webp,image/avif"
              onChange={(event) => void pick(event)}
            />
          </label>
          {background?.image && (
            <button
              type="button"
              className="cz-btn cz-btn--quiet"
              onClick={() => {
                edit(clearBackground(draft))
                announce('Background picture removed.')
              }}
            >
              Remove the picture
            </button>
          )}
        </div>
        {problem && (
          <p className="cz-problem" role="alert">
            {problem}
          </p>
        )}
      </Field>
      {background?.image && (
        <>
          <Field label="Fit" hint="Fill the window, or repeat the picture as tiles">
            <Segmented
              label="Fit"
              value={background.fit}
              options={[
                { value: 'cover', label: 'Fill' },
                { value: 'tile', label: 'Tile' },
              ]}
              onChange={(fit) => edit(setBackgroundFit(draft, fit))}
            />
          </Field>
          <Field label="Dim" hint="Fades the picture towards the page colour">
            <Slider
              label="Dim"
              value={background.dim}
              min={0}
              max={80}
              unit="%"
              onChange={(dim) => edit(setBackgroundDim(draft, dim), 'background:dim')}
            />
          </Field>
        </>
      )}
    </div>
  )
}
