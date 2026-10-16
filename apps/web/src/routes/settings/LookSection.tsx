import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DisplayCurrencySchema } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { currencyKey, useDisplayCurrency } from '../../data/currency.ts'
import '../../components/plugin-cards.css'
import { isTouchDevice, readSendKey, saveSendKey, type SendKey } from '../../data/send-key.ts'
import { readPackId, savePack } from '../../data/pack.ts'
import { saveTheme, readTheme, themeChoices, type ThemeChoice } from '../../data/theme.ts'
import { findPack, packs } from '../../styles/packs.ts'

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
  theme,
  packId,
  onPick,
}: {
  theme: ThemeChoice
  packId: string
  onPick: (id: string) => void
}) {
  return (
    <div id="look-style-panel" role="radiogroup" aria-label="Style" className="look-packs">
      {packs.map((pack) => (
        <button
          key={pack.id}
          type="button"
          role="radio"
          aria-checked={packId === pack.id}
          className="look-pack"
          data-pack-choice={pack.id}
          onClick={() => {
            onPick(pack.id)
            savePack(pack)
          }}
        >
          <span
            className="look-pack-preview"
            data-pack={pack.id}
            data-theme={previewMode(theme)}
            data-layout={pack.layout}
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
          <span className="look-pack-name">{pack.name}</span>
          <span className="look-pack-blurb">{pack.blurb}</span>
        </button>
      ))}
    </div>
  )
}

function ThemeCard() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  const [stylesOpen, setStylesOpen] = useState(false)
  const [packId, setPackId] = useState<string>(readPackId)
  return (
    <div className="plugins-card plugins-theme plugins-sendkey">
      <div className="plugins-theme-head">
        <span className="plugins-card-name" id="plugins-theme-label">
          Theme
        </span>
        <button
          type="button"
          className="look-style-toggle"
          aria-expanded={stylesOpen}
          aria-controls="look-style-panel"
          onClick={() => setStylesOpen((open) => !open)}
        >
          Style: {findPack(packId).name}
        </button>
      </div>
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
            aria-checked={theme === choice}
            className="plugins-theme-choice"
            data-theme-choice={choice}
            onClick={() => {
              setTheme(choice)
              saveTheme(choice)
            }}
          >
            <span className="plugins-theme-swatch" data-choice={choice} aria-hidden="true" />
            {themeLabels[choice]}
          </button>
        ))}
      </div>
      {stylesOpen && <StylePanel theme={theme} packId={packId} onPick={setPackId} />}
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
        <SendKeyCard />
        <CurrencyCard />
      </div>
    </section>
  )
}
