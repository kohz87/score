import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, vi } from 'vitest'
import { resetRenameSupport } from '../../src/knowledge/rename-noreplace.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import type { Harness } from './helpers.ts'

export interface Audit3State {
  h: Harness | undefined
  scratch: string[]
}

/** The cleanup, scratch-directory and restart helpers shared by the feature-split audit3-bb suites. */
export function createAudit3Helpers(state: Audit3State) {
  const install = () => {
    afterEach(async () => {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      resetRenameSupport()
      await state.h?.cleanup()
      state.h = undefined
      for (const dir of state.scratch.splice(0)) {
        fs.chmodSync(dir, 0o700)
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
  const read = (rel: string) => fs.readFileSync(path.join(state.h!.vaultDir, rel), 'utf8')
  const tmp = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-s3-')))
    state.scratch.push(dir)
    return dir
  }
  function externalReplace(file: string, content: string) {
    const temp = `${file}.editor-tmp`
    fs.writeFileSync(temp, content)
    fs.renameSync(temp, file)
  }
  /** A second vault object on the same files and database: a restart. */
  const restart = async (
    options: Partial<ConstructorParameters<typeof KnowledgeVault>[0]> = {},
  ) => {
    await state.h!.vault.close()
    const events: unknown[] = []
    const vault = new KnowledgeVault({
      vault: state.h!.vaultDir,
      db: state.h!.db,
      emit: (change) => void events.push(change),
      watch: false,
      stateDir: path.join(state.h!.dir, 'home', 'knowledge'),
      ...options,
    })
    return { vault, events }
  }
  const leftovers = (dir: string) =>
    fs.readdirSync(dir).filter((name) => name.startsWith('.score-move'))

  return { externalReplace, install, leftovers, read, restart, tmp }
}
