import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync as realRename,
  rmSync as realRm,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { ThemeStore, type ThemeFs } from '../../src/themes/store.ts'

// Gate findings #11 and #12: every step of a folder swap and of an id move can fail, or the process can stop between
// two steps. The theme must end up either wholly old or wholly new, and a restart must finish or undo what stopped.
let home: string
export let db: ScoreDb
export let store: ThemeStore
export { realRename, realRm }

export function setupStoreSwap() {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'score-swap-'))
    db = openDatabase(join(home, 'score.db'))
    migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    store = new ThemeStore(db, home)
  })
  afterEach(() => {
    db.close()
    realRm(home, { recursive: true, force: true })
  })
}

export const manifest = (id: string) => ThemeManifestSchema.parse({ format: 1, id, name: id })
export const asset = (text: string) => new Map([['img/a.png', Buffer.from(text)]])
export const fileOf = (id: string) => readFileSync(join(store.root, id, 'assets/img/a.png'), 'utf8')
export const leftovers = () => readdirSync(store.root).filter((name) => name.startsWith('.'))

export type Op = { op: 'rename' | 'rm'; from: string; to?: string }
/** File moves that throw when `fails` says so; with `dead`, every move after the first failure throws too (a crash). */
export function faulty(fails: (op: Op) => boolean, dead = false): ThemeFs {
  let down = false
  const gate = (op: Op) => {
    if (down || fails(op)) {
      if (dead) down = true
      throw new Error(`injected failure: ${op.op} ${basename(op.from)}`)
    }
  }
  return {
    rename(from, to) {
      gate({ op: 'rename', from, to })
      realRename(from, to)
    },
    rm(path) {
      gate({ op: 'rm', from: path })
      realRm(path, { recursive: true, force: true })
    },
  }
}
export const asideOld = (op: Op) => op.op === 'rename' && basename(op.to!).startsWith('.old-')
export const intoPlace = (op: Op) => op.op === 'rename' && basename(op.from).startsWith('.staging-')
export const dropOld = (op: Op) => op.op === 'rm' && basename(op.from).startsWith('.old-')
export const withFs = (fs: ThemeFs) => new ThemeStore(db, home, undefined, fs)
export const rowSource = (id: string) =>
  (
    db.sqlite.prepare('SELECT source FROM themes WHERE id = ?').get(id) as
      { source: string } | undefined
  )?.source ?? null
export const restart = () => {
  const fresh = new ThemeStore(db, home)
  fresh.recoverInterrupted()
  return fresh
}
export const blockRowWrites = () =>
  db.sqlite.exec(
    `CREATE TRIGGER block_themes BEFORE UPDATE ON themes BEGIN SELECT RAISE(ABORT, 'injected'); END;
     CREATE TRIGGER block_themes_new BEFORE INSERT ON themes BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
  )
export const unblockRowWrites = () =>
  db.sqlite.exec('DROP TRIGGER block_themes; DROP TRIGGER block_themes_new;')
