import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KnowledgeChanged } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { KnowledgeVault, type VaultOptions } from '../../src/knowledge/vault.ts'

const migrations = new URL('../../migrations/', import.meta.url).pathname

export interface Harness {
  dir: string
  vaultDir: string
  db: ScoreDb
  vault: KnowledgeVault
  events: KnowledgeChanged[]
  cleanup(): Promise<void>
}

export async function makeVault(
  options: Partial<Omit<VaultOptions, 'db' | 'emit' | 'vault'>> & {
    files?: Record<string, string>
  } = {},
): Promise<Harness> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-kn-')))
  const vaultDir = path.join(dir, 'vault')
  fs.mkdirSync(vaultDir)
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, rel), content)
  }
  const db = openDatabase(path.join(dir, 'home', 'score.db'))
  migrate(db, migrations)
  const events: KnowledgeChanged[] = []
  const rest: Partial<VaultOptions> = { ...options }
  delete (rest as { files?: unknown }).files
  const vault = new KnowledgeVault({
    watch: false,
    stateDir: path.join(dir, 'home', 'knowledge'),
    ...rest,
    vault: vaultDir,
    db,
    emit: (change) => void events.push(change),
  })
  await vault.start()
  return {
    dir,
    vaultDir,
    db,
    vault,
    events,
    async cleanup() {
      await vault.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const gitOut = (vaultDir: string, ...args: string[]) =>
  execFileSync('git', ['-C', vaultDir, ...args], { encoding: 'utf8' })
