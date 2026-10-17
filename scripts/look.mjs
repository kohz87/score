// `scripts/score look reset`: the host's way back to the default look (design 9 §4.5). Sets the shared theme to `score`
// and the colour mode to `system`, with Score stopped or running. It opens Score's database directly, like the other
// host commands; a browser that is already open picks the change up on its next reload (no stream event is sent).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resetLook } from '../apps/server/src/themes/look.ts'

const [command, ...rest] = process.argv.slice(2)
if (command !== 'reset' || rest.length > 0) {
  console.error('Usage: score look reset')
  process.exit(2)
}

const home = process.env.SCORE_HOME || join(homedir(), '.score')
const file = join(home, 'score.db')
if (!existsSync(file)) {
  console.log(
    'Nothing to reset: Score has no data in this folder yet, so the look is already the default.',
  )
  process.exit(0)
}
const sqlite = new DatabaseSync(file)
try {
  sqlite.exec('PRAGMA busy_timeout = 5000')
  const meta = sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'meta'")
    .get()
  if (meta === undefined) {
    console.log('Nothing to reset: this Score database has not been set up yet.')
  } else {
    sqlite.exec('BEGIN IMMEDIATE')
    resetLook(sqlite)
    sqlite.exec('COMMIT')
    console.log(
      'The look is back to the Score theme with the system colour mode. Reload open browsers.',
    )
  }
} catch (error) {
  if (sqlite.isTransaction) sqlite.exec('ROLLBACK')
  console.error(`score look reset: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  sqlite.close()
}
