import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

export const rate = num('LOAD_RATE', 1000)
export const sustainedMinutes = num('LOAD_MINUTES', 10)
export const burstMinutes = num('LOAD_BURST_MINUTES', 1)
export const burstFactor = 5
export const serverPort = num('SCORE_PORT', 8893)
export const webPort = num('SCORE_WEB_PORT', 5593)
export const withWeb = process.env.LOAD_WEB !== '0'
export const home = process.env.LOAD_HOME ?? mkdtempSync(join(tmpdir(), 'score-load-'))
export const origin = `http://127.0.0.1:${serverPort}`
export const webOrigin = `http://127.0.0.1:${webPort}`

export const BUDGETS = {
  ingestP95Ms: 25,
  lagP95Ms: 250,
  rssMb: 400,
  dbGrowthMbPer10Min: 50,
  renderMs: 2000,
  longTaskMs: 200,
}
