import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME_INSTALLATION_FILE, isInstallationId } from './installation-identity.ts'
import { writeDurable } from './installation-io.ts'
import { isObject } from './installation-json.ts'
import type { HomeFile } from './installation-types.ts'

export function readHomeInstallation(home: string): HomeFile {
  const file = join(home, HOME_INSTALLATION_FILE)
  if (!existsSync(file)) return { state: 'missing' }
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(value) && isInstallationId(value.id)) return { state: 'ok', id: value.id }
  } catch {
    // corrupt
  }
  return { state: 'corrupt' }
}

export function writeHomeInstallation(home: string, id: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeDurable(join(home, HOME_INSTALLATION_FILE), JSON.stringify({ version: 1, id }) + '\n')
}
