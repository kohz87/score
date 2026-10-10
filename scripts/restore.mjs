#!/usr/bin/env node
// `score restore <backup>`: the supported way to restore $SCORE_HOME (design 7.5 v3). It refuses while Score runs,
// moves the current home aside, copies the backup in and leaves a marker in the execution journal directory (which is
// outside the home) so that the next start sets the global admission fence and the untrusted-history marker before any
// orchestration can admit work. No shell is involved: only file APIs and argv.
import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const fail = (message) => {
  process.stderr.write(`score restore: ${message}\n`)
  process.exit(1)
}

const [backupArg, ...rest] = process.argv.slice(2)
if (!backupArg || rest.length > 0) fail('usage: score restore <backup-folder>')

const home = resolve(process.env.SCORE_HOME ?? join(homedir(), '.score'))
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
const journalDir = resolve(
  process.env.SCORE_JOURNAL_DIR ?? join(stateHome, 'score', 'execution-journal'),
)
const backup = resolve(backupArg)

if (!existsSync(backup) || !statSync(backup).isDirectory()) fail(`${backup} is not a folder`)
if (!existsSync(join(backup, 'score.db')))
  fail(`${backup} has no score.db: not a Score home backup`)
if (backup === home || backup.startsWith(`${home}/`)) fail('the backup cannot be inside the home')

// A running server owns the home: the pid file names a live Score process.
const pidFile = join(home, 'score.pid')
if (existsSync(pidFile)) {
  let pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      // No such process: the pid file is stale. Any other error (EPERM) means a process exists.
      if (error && error.code === 'ESRCH') pid = 0
    }
    if (pid > 0) fail(`Score is running (pid ${pid}); run \`score stop\` first`)
  }
}

const realHome = existsSync(home) ? realpathSync(home) : home
const scope = createHash('sha256').update(realHome).digest('hex').slice(0, 12)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// 1. The marker first: if anything below fails half-way, the next start is fenced anyway.
mkdirSync(journalDir, { recursive: true, mode: 0o700 })
const markerPath = join(journalDir, 'restore-marker.json')
const temp = `${markerPath}.tmp`
const fd = openSync(temp, 'w', 0o600)
try {
  writeSync(fd, JSON.stringify({ scope, at: new Date().toISOString(), backup }))
  fsyncSync(fd)
} finally {
  closeSync(fd)
}
renameSync(temp, markerPath)

// 2. Move the current home aside (never deleted) and copy the backup in.
let aside = null
if (existsSync(home)) {
  aside = `${home}.before-restore-${stamp}`
  renameSync(home, aside)
}
try {
  mkdirSync(dirname(home), { recursive: true })
  cpSync(backup, home, { recursive: true, errorOnExist: true, force: false })
  // Process-local files of the old home do not belong to the restored one.
  for (const name of ['score.pid', 'score.url', 'score.launcher.lock'])
    rmSync(join(home, name), { force: true })
} catch (error) {
  fail(
    `copying the backup failed (${error instanceof Error ? error.message : String(error)}); the previous home is at ${aside ?? 'nowhere (there was none)'}`,
  )
}

process.stdout.write(
  [
    `Restored ${backup} into ${home}.`,
    aside ? `The previous home was kept at ${aside}.` : 'There was no previous home.',
    'The next start puts the global admission fence on and marks execution history untrusted:',
    'review the reconciliation list in Score before lifting it. Hermes runs that Score started',
    'after this backup was made are unknown to the restored database and may still be running.',
    '',
  ].join('\n'),
)
