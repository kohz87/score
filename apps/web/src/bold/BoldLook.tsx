import { useState } from 'react'
import { Link } from 'react-router'
import { forgetStoredTheme, readStoredTheme, saveTheme, type ThemeChoice } from '../data/theme.ts'
import { saveLiveliness, useChosenLiveliness } from '../data/liveliness.ts'
import { isTouchDevice, readSendKey, saveSendKey, type SendKey } from '../data/send-key.ts'
import {
  saveTextScale,
  useTextScale,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
} from '../data/text-scale.ts'
import { CurrencyCard } from '../routes/settings/CurrencyCard.tsx'
import { useLook } from '../themes/use-look.ts'
import { pairingProblem } from './bold-errors.ts'

const modeLabels: Record<ThemeChoice, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'Match this device',
}
const modeOrder: ThemeChoice[] = ['dark', 'light', 'system']
const modeNotes: Record<ThemeChoice, string> = {
  dark: 'The default',
  light: 'Score’s original ground',
  system: 'Switches with your system',
}
const motionLabels: Record<'calm' | 'still', string> = {
  calm: 'Calm',
  still: 'Still',
}
const sendKeyLabels: Record<SendKey, string> = { enter: 'Enter', 'ctrl-enter': 'Ctrl+Enter' }

function ModePreview({ mode }: { mode: ThemeChoice }) {
  if (mode === 'system')
    return <span className="bold-look-mode-preview" data-preview="system" aria-hidden="true" />
  return (
    <span className="bold-look-mode-preview" data-preview={mode} aria-hidden="true">
      <span className="bold-look-mode-room">
        <span className="bold-look-mode-line bold-look-mode-line--mine" />
        <span className="bold-look-mode-line" />
      </span>
      <span className="bold-look-mode-card" />
    </span>
  )
}

/** PLAN 11.9a: Settings › Look, rebuilt from the prototype's sLook() and board 16. */
export function BoldLook() {
  const look = useLook()
  const motion = useChosenLiveliness()
  const scale = useTextScale()
  const deviceMode = readStoredTheme()
  const [sendKey, setSendKey] = useState<SendKey>(readSendKey)
  const [sharedTheme, setSharedTheme] = useState<string | null>(null)
  const [sharedMode, setSharedMode] = useState<ThemeChoice | null>(null)
  const [savingShared, setSavingShared] = useState(false)
  const [sharedProblem, setSharedProblem] = useState('')
  const shownSharedTheme = sharedTheme ?? look.sharedId
  const shownSharedMode = sharedMode ?? look.sharedMode
  const sharedChanged = shownSharedTheme !== look.sharedId || shownSharedMode !== look.sharedMode
  const sharedThemeName =
    look.themes.find((theme) => theme.id === look.sharedId)?.name ?? look.sharedId
  const deviceThemeName =
    look.themes.find((theme) => theme.id === look.deviceId)?.name ?? look.deviceId

  async function saveShared() {
    setSavingShared(true)
    setSharedProblem('')
    try {
      await look.saveShared({ activeTheme: shownSharedTheme, mode: shownSharedMode })
      setSharedTheme(null)
      setSharedMode(null)
    } catch (error) {
      setSharedProblem(
        pairingProblem(error) ?? 'Couldn’t save the look for every device. Try again.',
      )
    } finally {
      setSavingShared(false)
    }
  }

  return (
    <div className="bold-look">
      <h2 id="settings-look">Look</h2>

      <div className="row wrap bold-look-subhead">
        <b>Colours on this device</b>
        {deviceMode !== null && (
          <button type="button" className="link" onClick={forgetStoredTheme}>
            Follow the shared colours
          </button>
        )}
      </div>
      <div className="bold-look-modes" role="radiogroup" aria-label="Mode on this device">
        {modeOrder.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={look.mode === choice}
            className="bold-look-mode"
            data-mode={choice}
            onClick={() => saveTheme(choice)}
          >
            <ModePreview mode={choice} />
            <b>{modeLabels[choice]}</b>
            <span className="small muted">{modeNotes[choice]}</span>
          </button>
        ))}
      </div>

      <div className="grid2">
        <fieldset className="card bold-look-fieldset">
          <legend>Motion</legend>
          <div className="seg" role="radiogroup" aria-label="Motion on this device">
            {(['calm', 'still'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={motion === choice}
                className={motion === choice ? 'on' : undefined}
                onClick={() => saveLiveliness(choice)}
              >
                {motionLabels[choice]}
              </button>
            ))}
          </div>
          <span className="small muted">
            Calm: glows and typing dots. Still: nothing moves. Your device’s reduce-motion setting
            always wins.
          </span>
        </fieldset>

        <fieldset className="card bold-look-fieldset">
          <legend>Text size</legend>
          <div className="bold-look-scale">
            <span aria-hidden="true">A</span>
            <input
              type="range"
              min={TEXT_SCALE_MIN}
              max={TEXT_SCALE_MAX}
              step={TEXT_SCALE_STEP}
              value={scale}
              aria-label="Text size"
              aria-valuetext={`${Math.round(scale * 100)}%`}
              onChange={(event) => saveTextScale(Number(event.target.value))}
            />
            <span className="bold-look-scale-large" aria-hidden="true">
              A
            </span>
            <output>{Math.round(scale * 100)}%</output>
          </div>
          <span className="small muted">Messages, cards and settings scale together.</span>
        </fieldset>
      </div>

      <section className="card bold-look-themes" aria-labelledby="bold-look-themes-title">
        <div className="row wrap">
          <h3 id="bold-look-themes-title">Themes</h3>
          <button
            type="button"
            className="link bold-look-reset"
            data-protected="any"
            onClick={look.resetDevice}
          >
            Reset the look on this device
          </button>
        </div>
        <div className="bold-look-theme-list" role="radiogroup" aria-label="Style on this device">
          {look.themes.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={(look.deviceId ?? look.sharedId) === theme.id}
              className="bold-look-theme"
              data-theme-choice={theme.id}
              onClick={() => look.chooseForDevice(theme.id)}
            >
              {theme.name}
            </button>
          ))}
        </div>
        {look.deviceId && look.deviceId !== look.sharedId && (
          <p className="small muted">
            This device uses {deviceThemeName} instead of the shared {sharedThemeName}.{' '}
            <button type="button" className="link" onClick={() => look.chooseForDevice(null)}>
              Use the shared theme
            </button>
          </p>
        )}
        <span className="small muted">
          Agents keep their shapes in every theme, and anything that needs you always stands out.
          Lost? Press Ctrl+Shift+0 to reset the look.
        </span>
      </section>

      <section className="card bold-look-shared" aria-labelledby="bold-look-shared-title">
        <div className="row wrap">
          <h3 id="bold-look-shared-title">Every device</h3>
          <span className="small muted">Devices without their own choice follow this look.</span>
        </div>
        <div className="grid2 bold-look-shared-fields">
          <label>
            Theme for every device
            <select
              value={shownSharedTheme}
              onChange={(event) => setSharedTheme(event.target.value)}
            >
              {look.themes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Colours for every device
            <select
              value={shownSharedMode}
              onChange={(event) => setSharedMode(event.target.value as ThemeChoice)}
            >
              {modeOrder.map((choice) => (
                <option key={choice} value={choice}>
                  {modeLabels[choice]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row wrap">
          <button
            type="button"
            className="btn sm primary"
            disabled={!sharedChanged || savingShared}
            onClick={() => void saveShared()}
          >
            {savingShared ? 'Saving…' : 'Save for every device'}
          </button>
          {deviceMode !== null && (
            <span className="small muted">
              This device keeps its own colour choice until you follow the shared one.
            </span>
          )}
        </div>
        {sharedProblem && <p role="alert">{sharedProblem}</p>}
      </section>

      <div className="grid2">
        <section className="card bold-look-sendkey" aria-labelledby="bold-look-sendkey-title">
          <h3 id="bold-look-sendkey-title">Send messages with</h3>
          <div className="seg" role="radiogroup" aria-label="Send messages with">
            {(Object.keys(sendKeyLabels) as SendKey[]).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={sendKey === option}
                className={sendKey === option ? 'on' : undefined}
                onClick={() => {
                  setSendKey(option)
                  saveSendKey(option)
                }}
              >
                {sendKeyLabels[option]}
              </button>
            ))}
          </div>
          <span className="small muted">
            {sendKey === 'enter'
              ? 'Enter sends; Shift+Enter adds a new line.'
              : 'Ctrl+Enter (or Cmd+Enter) sends; Enter adds a new line.'}
            {isTouchDevice() && ' On this touch screen Enter always adds a new line: tap Send.'}
          </span>
        </section>
      </div>

      <section className="card bold-look-customize" aria-labelledby="bold-look-customize-title">
        <div>
          <h3 id="bold-look-customize-title">Colours, fonts and spacing</h3>
          <span className="small muted">
            Change them with a live preview. A built-in style is copied first, so it stays as it is.
          </span>
        </div>
        <Link
          className="btn sm"
          to={`/b/settings/look/customize/${look.deviceId ?? look.sharedId}`}
        >
          Open the Customizer
        </Link>
      </section>

      <CurrencyCard />
    </div>
  )
}
