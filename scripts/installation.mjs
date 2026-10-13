#!/usr/bin/env node
// `score installation status|confirm-move|confirm-copy|reset-history` (7.7a design v7 §2). Score refuses coding and executor
// admission for a home that sits at a path its installation registry does not know (a moved or copied folder) until the
// person says which it is:
//   confirm-move  the folder moved or was renamed: it keeps its installation id and journal (the old path is refused).
//   confirm-copy  the folder is a copy: it gets its own installation id; the run history it inherited is untrusted.
//   reset-history Score holds all agent work (a copied home, a lost or truncated execution journal): retire every
//                 unfinished run, Stop, process and launch it knows of, start a fresh journal and carry on.
// Refuses while Score runs on this home. Only file APIs; no shell.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { journalInsideHome } from '../apps/server/src/journal-location.ts'
import {
  confirmCopy,
  confirmMove,
  readHomeInstallation,
  registeredIdForHome,
  resolveInstallation,
} from '../apps/server/src/installation.ts'
import { acquireHomeLock } from '../apps/server/src/db/lock.ts'
import { resetHistory } from '../apps/server/src/history-reset.ts'

const fail = (message) => {
  process.stderr.write(`score installation: ${message}\n`)
  process.exit(1)
}

const [command, ...args] = process.argv.slice(2)
const yes = command === 'reset-history' && args.includes('--yes')
const rest = args.filter((arg) => !(yes && arg === '--yes'))
if (
  !['status', 'confirm-move', 'confirm-copy', 'reset-history'].includes(command ?? '') ||
  rest.length > 0
)
  fail('usage: score installation status|confirm-move|confirm-copy|reset-history [--yes]')

const requestedHome = resolve(process.env.SCORE_HOME ?? join(homedir(), '.score'))
const home = existsSync(requestedHome) ? realpathSync(requestedHome) : requestedHome
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
const journalDir = resolve(
  process.env.SCORE_JOURNAL_DIR ?? join(stateHome, 'score', 'execution-journal'),
)
{
  const inside = journalInsideHome(journalDir, home)
  if (inside) fail(inside)
}

if (command === 'status') {
  const copy = readHomeInstallation(home)
  const registered = registeredIdForHome(journalDir, home)
  process.stdout.write(
    [
      `Home: ${home}`,
      `Journal folder: ${journalDir}`,
      `Home says: ${copy.state === 'ok' ? copy.id : copy.state}`,
      `Registry says: ${registered ?? 'no entry for this folder'}`,
      '',
    ].join('\n'),
  )
  process.exit(0)
}

const pidFile = join(home, 'score.pid')
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (Number.isInteger(pid) && pid > 0) {
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error && error.code === 'ESRCH') alive = false
    }
    if (alive) fail(`Score is running (pid ${pid}); run \`score stop\` first`)
  }
}

if (command === 'reset-history') {
  // The exact lock a running server holds (<home>/score.lock), taken before the identity is resolved and held until the
  // process ends: a server started in between, or one started directly without score.pid, makes the reset refuse
  // (re-review 6 #6). A pid file cannot provide this exclusion.
  let homeLock
  try {
    homeLock = acquireHomeLock(home)
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}; run \`score stop\` first`)
  }
  process.on('exit', () => {
    try {
      homeLock.release()
    } catch {
      // A lock that cannot be released is judged stale by the next contender.
    }
  })
  const resolved = resolveInstallation({ journalDir, home })
  if (!resolved.ok)
    fail(`${resolved.message}\nResolve that first (it is not something a history reset can fix).`)
  const warning = [
    'This starts a new run history for this Score home.',
    '',
    '  Every unfinished orchestration step, Stop, coding run, process and launch Score knows of is retired.',
    '  Nothing retired is ever sent, stopped or signalled again, so work it started may still be running in',
    '  Hermes or as a coding service: check both yourself.',
    '  Score keeps the old journal and launch folders as an archive beside the new journal.',
    '',
  ].join('\n')
  process.stdout.write(`${warning}\n`)
  if (!yes) {
    if (!process.stdin.isTTY) fail('this needs an answer; run it in a terminal, or pass --yes')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('Reset the history? Type "reset" to continue: ')).trim()
    rl.close()
    if (answer !== 'reset') fail('nothing was changed')
  }
  const done = resetHistory({
    journalDir,
    namespaceDir: resolved.namespaceDir,
    installationId: resolved.id,
    home,
    dbFile: join(home, 'score.db'),
    homeLockHeld: true,
  })
  const counts = done.database
    ? `${done.database.attempts} orchestration steps, ${done.database.intents} start requests, ${done.database.processes} process records and ${done.database.launches} coding launches retired`
    : 'no database yet'
  process.stdout.write(
    `History reset (${counts}). The old journal (${done.archived} records) is in ${join(resolved.namespaceDir, done.archive)}. Start Score again.\n`,
  )
  process.exit(0)
}

const result =
  command === 'confirm-move' ? confirmMove({ journalDir, home }) : confirmCopy({ journalDir, home })
if (!result.ok) fail(result.message)
process.stdout.write(`${result.message}\n`)
