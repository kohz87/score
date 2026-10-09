import type { CodingRuntime } from '@score/contract'
import { claudeDriver } from './claude.ts'
import { codexDriver } from './codex.ts'
import { opencodeDriver } from './opencode.ts'
import type { CodingDriver } from './types.ts'

export const DRIVERS: Record<CodingRuntime, CodingDriver> = {
  'claude-code': claudeDriver,
  codex: codexDriver,
  opencode: opencodeDriver,
}
export const driverFor = (runtime: CodingRuntime): CodingDriver => DRIVERS[runtime]

/** The version gate (review 2026-10-09, 7.2 #2): a version is tested when it starts with a tested series. */
export function isTestedVersion(driver: CodingDriver, version: string): boolean {
  return driver.testedSeries.some(
    (series) => version === series || version.startsWith(`${series}.`),
  )
}
