import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DisplayCurrencySchema, type ThemeSummary } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { currencyKey, useDisplayCurrency } from '../../data/currency.ts'
import '../../components/plugin-cards.css'
import { isTouchDevice, readSendKey, saveSendKey, type SendKey } from '../../data/send-key.ts'
import { saveTheme, themeChoices, type ThemeChoice } from '../../data/theme.ts'
import { packs } from '../../styles/packs.ts'
import { useLook } from '../../themes/use-look.ts'
import { checkSecurityPassword, passwordCheckProblem } from '../user/ViewSwitch.tsx'
import { readGuard, saveGuard } from '../user/user-view.ts'

const themeLabels: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/** Light or dark for the previews: the saved choice, or the device's when it is System. */
function previewMode(theme: ThemeChoice): 'light' | 'dark' {
  if (theme !== 'system') return theme
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function StylePanel({
  mode,
  themes,
  selectedId,
  onPick,
}: {
  mode: ThemeChoice
  themes: ThemeSummary[]
  selectedId: string
  onPick: (id: string) => void
}) {
  return (
    <div role="radiogroup" aria-label="Style" className="look-packs">
      {themes.map((theme) => {
        const pack = packs.find((item) => item.id === theme.id)
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selectedId === theme.id}
            className="look-pack"
            data-pack-choice={theme.id}
            onClick={() => onPick(theme.id)}
          >
            <span
              className="look-pack-preview"
              data-pack={pack?.id ?? 'score'}
              data-theme={previewMode(mode)}
              data-layout={pack?.layout ?? 'top'}
              aria-hidden="true"
            >
              <span className="look-pack-nav" />
              <span className="look-pack-page">
                <span className="look-pack-title">Aa</span>
                <span className="look-pack-card">
                  <span className="look-pack-line" />
                  <span className="look-pack-line look-pack-line--short" />
                  <span className="look-pack-button" />
                </span>
              </span>
            </span>
            <span className="look-pack-name">{theme.name}</span>
            <span className="look-pack-blurb">
              {pack?.blurb ?? theme.description ?? 'A theme added to this Score.'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ThemeCard() {
  const look = useLook()
  const [problem, setProblem] = useState('')
  const [sharedChoice, setSharedChoice] = useState<string | null>(null)
  const [sharedMode, setSharedMode] = useState<ThemeChoice | null>(null)
  const [saving, setSaving] = useState(false)
  const shownShared = sharedChoice ?? look.sharedId
  const shownMode = sharedMode ?? look.sharedMode
  const changed = shownShared !== look.sharedId || shownMode !== look.sharedMode
  const sharedName = look.themes.find((item) => item.id === look.sharedId)?.name ?? look.sharedId
  const deviceName = look.themes.find((item) => item.id === look.deviceId)?.name ?? look.deviceId
  async function saveShared() {
    setSaving(true)
    setProblem('')
    try {
      await look.saveShared({ activeTheme: shownShared, mode: shownMode })
      setSharedChoice(null)
      setSharedMode(null)
    } catch {
      setProblem('Couldn’t save the theme for every device. Is this browser paired?')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="plugins-card plugins-theme plugins-sendkey">
      <span className="plugins-card-name" id="plugins-theme-label">
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby="plugins-theme-label"
        className="plugins-theme-choices"
      >
        {themeChoices.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={look.mode === choice}
            className="plugins-theme-choice"
            data-theme-choice={choice}
            onClick={() => saveTheme(choice)}
          >
            <span className="plugins-theme-swatch" data-choice={choice} aria-hidden="true" />
            {themeLabels[choice]}
          </button>
        ))}
      </div>
      <span className="plugins-card-name">Style on this device</span>
      <StylePanel
        mode={look.mode}
        themes={look.themes}
        selectedId={look.deviceId ?? look.sharedId}
        onPick={look.chooseForDevice}
      />
      {look.deviceId && look.deviceId !== look.sharedId && (
        <p className="settings-muted">
          This device uses {deviceName} instead of the shared {sharedName}.{' '}
          <button type="button" className="look-link" onClick={() => look.chooseForDevice(null)}>
            Use the shared theme
          </button>
        </p>
      )}
      <div className="look-shared">
        <label>
          Theme for every device
          <select value={shownShared} onChange={(event) => setSharedChoice(event.target.value)}>
            {look.themes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Colours for every device
          <select
            value={shownMode}
            onChange={(event) => setSharedMode(event.target.value as ThemeChoice)}
          >
            {themeChoices.map((choice) => (
              <option key={choice} value={choice}>
                {themeLabels[choice]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="settings-pill"
          disabled={!changed || saving}
          onClick={() => void saveShared()}
        >
          {saving ? 'Saving…' : 'Save for every device'}
        </button>
      </div>
      {look.deviceId && look.deviceId !== look.sharedId && (
        <p className="settings-muted">Devices without their own choice follow {sharedName}.</p>
      )}
      {problem && <p role="alert">{problem}</p>}
    </div>
  )
}

/** The way back from any theme (design §4.5): also Ctrl+Shift+0, the command palette and ?look=safe. */
function ResetLookCard() {
  const look = useLook()
  return (
    <div className="plugins-card plugins-theme plugins-sendkey look-reset" data-protected="any">
      <span className="plugins-card-name" id="plugins-reset-label">
        If a theme gets in the way
      </span>
      <p className="settings-muted" id="plugins-reset-help">
        Go back to Score’s own look on this device. You can also press Ctrl+Shift+0, search for
        “Reset look” with Ctrl+K, or open Score with ?look=safe.
      </p>
      <button
        type="button"
        className="settings-pill"
        aria-describedby="plugins-reset-help"
        onClick={look.resetDevice}
      >
        Reset look on this device
      </button>
    </div>
  )
}

const sendKeyLabels: Record<SendKey, string> = { enter: 'Enter', 'ctrl-enter': 'Ctrl+Enter' }

function SendKeyCard() {
  const [choice, setChoice] = useState<SendKey>(readSendKey)
  return (
    <div className="plugins-card plugins-theme plugins-sendkey">
      <span className="plugins-card-name" id="plugins-sendkey-label">
        Send messages with
      </span>
      <div
        role="radiogroup"
        aria-labelledby="plugins-sendkey-label"
        className="plugins-theme-choices"
      >
        {(Object.keys(sendKeyLabels) as SendKey[]).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={choice === option}
            className="plugins-theme-choice"
            onClick={() => {
              setChoice(option)
              saveSendKey(option)
            }}
          >
            {sendKeyLabels[option]}
          </button>
        ))}
      </div>
      <p className="settings-muted">
        {sendKeyNote(choice)}
        {isTouchDevice() && ' On this touch screen Enter always adds a new line: tap Send.'}
      </p>
    </div>
  )
}

function sendKeyNote(choice: SendKey): string {
  return choice === 'enter'
    ? 'Enter sends; Shift+Enter adds a new line.'
    : 'Ctrl+Enter (or Cmd+Enter) sends; Enter adds a new line.'
}

/** Decision 87: a per-browser convenience for a shared screen, checked with the security password. */
function AdminGuardCard() {
  const [on, setOn] = useState(readGuard)
  const [asking, setAsking] = useState(false)
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState('')
  const [pending, setPending] = useState(false)
  async function turnOn(event: FormEvent) {
    event.preventDefault()
    if (pending || !password) return
    setPending(true)
    setProblem('')
    try {
      await checkSecurityPassword(password)
      saveGuard(true)
      setOn(true)
      setAsking(false)
      setPassword('')
    } catch (error) {
      setProblem(passwordCheckProblem(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="plugins-card plugins-theme plugins-sendkey guard-form" data-protected="any">
      <span className="plugins-card-name" id="plugins-guard-label">
        Admin view on this browser
      </span>
      <label className="look-check">
        <input
          type="checkbox"
          checked={on || asking}
          aria-describedby="plugins-guard-help"
          onChange={(event) => {
            setProblem('')
            if (!event.target.checked) {
              saveGuard(false)
              setOn(false)
              setAsking(false)
              setPassword('')
            } else setAsking(true)
          }}
        />
        <span>Ask for the security password to open the admin view</span>
      </label>
      <p className="settings-muted" id="plugins-guard-help">
        Only this browser asks. It is a convenience for a shared screen, not access control: the
        same Score stays open to anyone who can reach it.
      </p>
      {asking && !on && (
        <form
          className="look-guard-form"
          onSubmit={(event) => void turnOn(event)}
          aria-label="Turn on the password check"
        >
          <label>
            Security password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" className="settings-pill" disabled={pending || !password}>
            {pending ? 'Checking…' : 'Turn on'}
          </button>
        </form>
      )}
      {problem && <p role="alert">{problem}</p>}
    </div>
  )
}

function CurrencyCard() {
  const current = useDisplayCurrency()
  const queryClient = useQueryClient()
  const [code, setCode] = useState<string | null>(null)
  const [rate, setRate] = useState<string | null>(null)
  const shownCode = code ?? current.data?.code ?? 'USD'
  const shownRate = rate ?? String(current.data?.rate ?? 1)
  const parsedRate = Number(shownRate)
  const valid = /^[A-Za-z]{3}$/.test(shownCode) && Number.isFinite(parsedRate) && parsedRate > 0
  const save = useMutation({
    mutationFn: async () =>
      DisplayCurrencySchema.parse(
        await apiFetch('settings/currency', {
          method: 'PUT',
          body: JSON.stringify({ code: shownCode.toUpperCase(), rate: parsedRate }),
        }),
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(currencyKey, saved)
      setCode(null)
      setRate(null)
    },
  })
  return (
    <form
      className="plugins-card plugins-currency"
      aria-label="Display currency"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        if (valid) save.mutate()
      }}
    >
      <span className="plugins-card-name">Display currency</span>
      <p className="settings-muted">
        Reports can also show spend in another currency. Score does not look up exchange rates: type
        the rate yourself (how many units of the currency equal 1 USD). Use USD to turn it off.
      </p>
      <label>
        Currency code
        <input
          value={shownCode}
          maxLength={3}
          autoCapitalize="characters"
          onChange={(event) => setCode(event.target.value.toUpperCase())}
        />
      </label>
      <label>
        Rate (1 USD =)
        <input
          inputMode="decimal"
          value={shownRate}
          disabled={shownCode.toUpperCase() === 'USD'}
          onChange={(event) => setRate(event.target.value)}
        />
      </label>
      <button type="submit" className="settings-pill" disabled={!valid || save.isPending}>
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {save.isSuccess && <p role="status">Saved.</p>}
      {save.isError && <p role="alert">Couldn’t save. Is this browser paired?</p>}
    </form>
  )
}

export function LookSection() {
  return (
    <section id="look" className="settings-card" aria-labelledby="settings-look">
      <div>
        <h2 id="settings-look">Look</h2>
        <p className="settings-muted-strong">How Score looks on this device.</p>
      </div>
      <div className="look-stack">
        <ThemeCard />
        <ResetLookCard />
        <SendKeyCard />
        <AdminGuardCard />
        <CurrencyCard />
      </div>
    </section>
  )
}
