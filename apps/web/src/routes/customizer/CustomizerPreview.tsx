import type { Finding } from '../../themes/customizer/checks.ts'
import type { Mode } from '../../themes/customizer/draft.ts'
import type { TextFinding } from '../../themes/customizer/measure.ts'
import type { PreviewResult } from '../../themes/preview-paint.ts'
import { Segmented } from './controls.tsx'
import type { Busy, Target } from './customizer-types.ts'
import { PreviewFrame, type PreviewDraft } from './PreviewFrame.tsx'
import {
  previewDevices,
  previewPages,
  type PreviewDevice,
  type PreviewPage,
} from './preview-pages.ts'

type PreviewSectionProps = {
  target: Target
  dirty: boolean
  busy: Busy
  mode: Mode
  setMode: (mode: Mode) => void
  pageId: string
  setPageId: (pageId: string) => void
  deviceId: PreviewDevice['id']
  setDeviceId: (deviceId: PreviewDevice['id']) => void
  page: PreviewPage
  device: PreviewDevice
  previewDraft: PreviewDraft
  onPainted: (result: PreviewResult) => void
  onText: (where: PreviewPage, list: TextFinding[]) => void
  shownFindings: Finding[]
  filesUsed: number
  onUse: (scope: 'device' | 'everyone') => void
}

export function CustomizerPreview({
  target,
  dirty,
  busy,
  mode,
  setMode,
  pageId,
  setPageId,
  deviceId,
  setDeviceId,
  page,
  device,
  previewDraft,
  onPainted,
  onText,
  shownFindings,
  filesUsed,
  onUse,
}: PreviewSectionProps) {
  return (
    <section className="cz-preview" aria-label="Preview">
      <div className="cz-preview-bar">
        <label>
          <span className="cz-visually-hidden">Page to preview</span>
          <select
            className="score-select cz-select"
            value={pageId}
            onChange={(event) => setPageId(event.target.value)}
          >
            {previewPages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <Segmented
          label="Preview colours"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <Segmented
          label="Preview size"
          value={deviceId}
          onChange={setDeviceId}
          options={previewDevices.map((item) => ({ value: item.id, label: item.label }))}
        />
      </div>
      <PreviewFrame
        draft={previewDraft}
        mode={mode}
        page={page}
        device={device}
        onPainted={onPainted}
        onText={onText}
      />
      <section className="cz-checks" aria-label="Contrast checks">
        <h2>
          {shownFindings.length === 0
            ? 'No contrast problems found'
            : shownFindings.length === 1
              ? '1 contrast problem'
              : `${shownFindings.length} contrast problems`}
        </h2>
        {shownFindings.length === 0 ? (
          <p>Text on this page is readable with these colours.</p>
        ) : (
          <ul>
            {shownFindings.map((finding) => (
              <li key={finding.id}>
                <strong>{finding.where}:</strong> {finding.text}
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer className="cz-use">
        <p className="cz-note">
          {dirty || !target.exists
            ? 'Using a theme saves your changes first.'
            : filesUsed > 0
              ? 'Saved, with its files.'
              : 'Saved.'}
        </p>
        <div className="cz-use-buttons">
          <button
            type="button"
            className="cz-btn"
            disabled={!!busy}
            onClick={() => onUse('device')}
          >
            Use on this device
          </button>
          <button
            type="button"
            className="cz-btn cz-btn--primary"
            disabled={!!busy}
            onClick={() => onUse('everyone')}
          >
            Use for every device
          </button>
        </div>
      </footer>
      <p className="cz-lost">
        Lost? <kbd>Ctrl+Shift+0</kbd> resets the look on this device, and <kbd>⌘K</kbd> always finds
        Settings.
      </p>
    </section>
  )
}
