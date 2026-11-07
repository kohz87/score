import { formatMoney, useDisplayCurrency, USD } from '../data/currency.ts'

/**
 * Money as the classic Reports page shows it: USD, or the currency from Settings › Look when the person picked it there
 * (remembered per browser), so both shells show the same numbers.
 */
export function useMoney(): (usd: number | null) => string {
  const configured = useDisplayCurrency().data ?? USD
  let other = false
  try {
    other = localStorage.getItem('score.reports.currency') === 'other'
  } catch {
    // Blocked storage: USD.
  }
  const shown = configured.code !== 'USD' && other ? configured : USD
  return (usd) => formatMoney(usd, shown)
}
