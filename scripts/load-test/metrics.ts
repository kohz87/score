import { statSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './config.ts'

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

export const round = (value: number, digits = 1) => Number(value.toFixed(digits))

export const dist = (values: number[]) => ({
  count: values.length,
  p50: round(percentile(values, 50), 2),
  p95: round(percentile(values, 95), 2),
  p99: round(percentile(values, 99), 2),
  max: round(
    values.reduce((a, b) => Math.max(a, b), 0),
    2,
  ),
})

export type Dist = ReturnType<typeof dist>

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const fileSize = (path: string) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export const dbBytes = () => fileSize(join(home, 'score.db')) + fileSize(join(home, 'score.db-wal'))

export const maxOf = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0)
