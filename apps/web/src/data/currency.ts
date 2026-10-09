import { DisplayCurrencySchema, type DisplayCurrency } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

export const USD: DisplayCurrency = { code: 'USD', rate: 1 }
export const currencyKey = ['settings', 'currency'] as const

/** The display currency the person set in Settings › Look (USD until they do). */
export function useDisplayCurrency() {
  return useQuery({
    queryKey: currencyKey,
    queryFn: async ({ signal }) =>
      DisplayCurrencySchema.parse(await apiFetch('settings/currency', { signal })),
    retry: false,
  })
}

/** Reports are in USD; the typed rate converts them. Rounded to the displayed cent so sums of shown values agree. */
export function convertUsd(usd: number, currency: DisplayCurrency): number {
  return Math.round((usd * currency.rate + Number.EPSILON) * 100) / 100
}

/** "$4.20", "€3.86", or "CHF 3.86" for a code the browser has no symbol for. Null = unknown = "—". */
export function formatMoney(usd: number | null, currency: DisplayCurrency = USD): string {
  if (usd === null) return '—'
  const value = convertUsd(usd, currency)
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.code,
      currencyDisplay: 'narrowSymbol',
    }).format(value)
  } catch {
    return `${currency.code} ${value.toFixed(2)}`
  }
}
