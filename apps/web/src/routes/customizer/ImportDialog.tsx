import type { ThemeSummary } from '@score/contract'
import { useMemo, useState } from 'react'
import { MAX_ASSET_BYTES, mimeForPath, toDataUrl } from '../../themes/customizer/asset-types.ts'
import { describeSaveError, installThemeZip } from '../../themes/customizer/api.ts'
import { describeChanges } from '../../themes/customizer/describe.ts'
import { describeDropped, reportSummary } from '../../themes/customizer/report-text.ts'
import type { ThemePackage } from '../../themes/customizer/package.ts'
import { isReservedId } from '../../themes/customizer/draft.ts'
import { sanitiseCss } from '../../themes/sanitise.ts'
import { Modal, Segmented } from './controls.tsx'
import { PreviewFrame } from './PreviewFrame.tsx'
import { previewDevices, previewPages } from './preview-pages.ts'

// The install preview (design §4.6): what the file is, what it changes, what the checks removed and how it looks.
// Nothing is sent, and nothing applies, until Install; after Install it is stored but still not in use.

export type ImportCandidate =
  | { ok: true; name: string; bytes: Uint8Array; pkg: ThemePackage }
  | { ok: false; name: string; reasons: string[] }

export function ImportDialog({
  candidate,
  themes,
  onClose,
  onOpen,
  onInstalled,
}: {
  candidate: ImportCandidate
  themes: ThemeSummary[]
  onClose: () => void
  /** Open the installed theme in the Customizer. */
  onOpen: (id: string) => void
  onInstalled: () => void
}) {
  if (!candidate.ok)
    return (
      <Modal title="This file can’t be installed" onClose={onClose}>
        <p>
          <strong>{candidate.name}</strong> isn’t a theme Score can use:
        </p>
        <ul className="cz-reasons">
          {candidate.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <div className="cz-modal-actions">
          <button type="button" className="cz-btn cz-btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    )
  return (
    <Review
      candidate={candidate}
      themes={themes}
      onClose={onClose}
      onOpen={onOpen}
      onInstalled={onInstalled}
    />
  )
}

function Review({
  candidate,
  themes,
  onClose,
  onOpen,
  onInstalled,
}: {
  candidate: Extract<ImportCandidate, { ok: true }>
  themes: ThemeSummary[]
  onClose: () => void
  onOpen: (id: string) => void
  onInstalled: () => void
}) {
  const { pkg } = candidate
  const { manifest } = pkg
  const existing = themes.find((theme) => theme.id === manifest.id)
  const reserved = isReservedId(manifest.id)
  const [replace, setReplace] = useState(false)
  const [state, setState] = useState<'review' | 'installing' | 'done'>('review')
  const [problem, setProblem] = useState('')
  const [mode, setMode] = useState<'light' | 'dark'>('light')
  const changes = useMemo(() => describeChanges(manifest, pkg.css), [manifest, pkg.css])
  const sanitised = useMemo(() => sanitiseCss(pkg.css), [pkg.css])
  const lines = describeDropped(sanitised.report)
  const draft = useMemo(() => {
    const urls = new Map<string, string>()
    return {
      manifest,
      css: pkg.css,
      themeId: manifest.id,
      resolve: (ref: string) => {
        const path = ref.slice('asset:'.length)
        const bytes = pkg.assets.get(path)
        if (!bytes || bytes.length > MAX_ASSET_BYTES) return null
        const known = urls.get(path)
        if (known) return known
        const made = toDataUrl(bytes, mimeForPath(path))
        urls.set(path, made)
        return made
      },
    }
  }, [manifest, pkg])
  const blocked = reserved || existing?.source === 'builtin'
  const mustReplace = !!existing && !blocked

  async function install() {
    setState('installing')
    setProblem('')
    try {
      await installThemeZip(candidate.bytes, { replace: mustReplace && replace })
      setState('done')
      onInstalled()
    } catch (error) {
      setProblem(describeSaveError(error).text)
      setState('review')
    }
  }

  if (state === 'done')
    return (
      <Modal title={`${manifest.name} is installed`} onClose={onClose}>
        <p>
          It’s stored in Score but not in use yet. Open it to adjust it, or choose it in Settings ›
          Look.
        </p>
        <div className="cz-modal-actions">
          <button type="button" className="cz-btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="cz-btn cz-btn--primary"
            onClick={() => onOpen(manifest.id)}
          >
            Open in the Customizer
          </button>
        </div>
      </Modal>
    )

  return (
    <Modal title={`Install “${manifest.name}”?`} onClose={onClose} wide>
      <div className="cz-import">
        <div className="cz-import-info">
          <dl className="cz-facts">
            <div>
              <dt>Name</dt>
              <dd>{manifest.name}</dd>
            </div>
            <div>
              <dt>Author</dt>
              <dd>{manifest.author ?? 'Not given'}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{manifest.version}</dd>
            </div>
            {manifest.description && (
              <div>
                <dt>About</dt>
                <dd>{manifest.description}</dd>
              </div>
            )}
          </dl>
          <section aria-label="What it changes">
            <h3>What it changes</h3>
            <ul>
              {changes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section aria-label="What the checks removed" aria-live="polite">
            <h3>What the checks removed</h3>
            <p>{reportSummary(sanitised.report)}</p>
            {lines.length > 0 && (
              <ul className="cz-report-list">
                {lines.map((line, index) => (
                  <li key={`${index}:${line.rule}`}>
                    <code>{line.rule}</code> <span>{line.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {blocked && (
            <p className="cz-problem" role="alert">
              This theme uses the address of a built-in theme (“{manifest.id}”), so it can’t be
              installed. Change the id in theme.json and try again.
            </p>
          )}
          {mustReplace && (
            <label className="cz-check">
              <input
                type="checkbox"
                checked={replace}
                onChange={(event) => setReplace(event.target.checked)}
              />
              <span>
                A theme called “{existing?.name}” is already installed with this address. Replace it
                with this one.
              </span>
            </label>
          )}
          {problem && (
            <p className="cz-problem" role="alert">
              {problem}
            </p>
          )}
        </div>
        <div className="cz-import-preview">
          <Segmented
            label="Preview colours"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
          <div className="cz-import-stage">
            <PreviewFrame
              draft={draft}
              mode={mode}
              page={previewPages[0]!}
              device={previewDevices[0]!}
            />
          </div>
        </div>
      </div>
      <div className="cz-modal-actions">
        <button type="button" className="cz-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="cz-btn cz-btn--primary"
          disabled={state === 'installing' || blocked || (mustReplace && !replace)}
          onClick={() => void install()}
        >
          {state === 'installing' ? 'Installing…' : 'Install'}
        </button>
      </div>
    </Modal>
  )
}
