#!/usr/bin/env node
// `score installation status|confirm-move|confirm-copy` (7.7a design v7 §2). Score refuses coding and executor
// admission for a home that sits at a path its installation registry does not know (a moved or copied folder) until the
// person says which it is:
//   confirm-move  the folder moved or was renamed: it keeps its installation id and journal (the old path is refused).
//   confirm-copy  the folder is a copy: it gets its own installation id; the run history it inherited is untrusted.
// Refuses while Score runs on this home. Only file APIs; no shell.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { journalInsideHome } from '../apps/server/src/journal-location.ts'
import {
  confirmCopy,
  confirmMove,
  readHomeInstallation,
  registeredIdForHome,
} from '../apps/server/src/installation.ts'

const fail = (message) => {
  process.stderr.write(`score installation: ${message}\n`)
  process.exit(1)
}

const [command, ...rest] = process.argv.slice(2)
if (!['status', 'confirm-move', 'confirm-copy'].includes(command ?? '') || rest.length > 0)
  fail('usage: score installation status|confirm-move|confirm-copy')

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

const result =
  command === 'confirm-move' ? confirmMove({ journalDir, home }) : confirmCopy({ journalDir, home })
if (!result.ok) fail(result.message)
process.stdout.write(`${result.message}\n`)
