import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DisplayCurrencySchema } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { currencyKey, useDisplayCurrency } from '../../data/currency.ts'
import '../../components/plugin-cards.css'

/** Settings › Look: the display currency used by Usage when a person picks it there. */
export function CurrencyCard() {
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
