import type { CodingRuntime } from '@score/contract'
import { antigravityDriver } from './antigravity.ts'
import { claudeDriver } from './claude.ts'
import { codexDriver } from './codex.ts'
import type { CodingDriver } from './types.ts'

export const DRIVERS: Record<CodingRuntime, CodingDriver> = {
  'claude-code': claudeDriver,
  codex: codexDriver,
  antigravity: antigravityDriver,
}
export const driverFor = (runtime: CodingRuntime): CodingDriver => DRIVERS[runtime]

/**
 * The version gate (review 2026-10-09, 7.2 #2): only the exact versions Score was tested with run unasked; any other
 * version (newer, older, a patch release) needs the person's confirmation for that agent.
 */
export function isTestedVersion(driver: CodingDriver, version: string): boolean {
  return driver.testedVersions.includes(version)
}
