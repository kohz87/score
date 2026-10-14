// A throwaway "server" for the crash-recovery test: starts one coding turn against the fake CLI, prints the pid of the
// CLI child, then idles until the test kills it with SIGKILL (a crash: no cleanup runs, the child is left behind).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { createIngest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import { insertCodingAgent } from '../../src/runtimes/coding/store.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'

const [dir, workspace, fakeCli] = process.argv.slice(2) as [string, string, string]
mkdirSync(join(dir, 'home'), { recursive: true })
const db = openDatabase(join(dir, 'score.db'))
migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
const ingest = createIngest(db)
const runtime = new CodingRuntime({
  db,
  ingest,
  locator: new CliLocator({ fakeCli }),
  home: join(dir, 'home'),
  policy: defaultRootPolicy([join(dir, 'home')]),
})
insertCodingAgent(db.sqlite, {
  id: 'crashy',
  name: 'Crashy',
  role: '',
  runtime: 'claude-code',
  workspace,
  permission: 'workspace-write',
  model: null,
  style: { color: '#19C39A', shape: 'hexagon' },
  createdAt: new Date().toISOString(),
})
await runtime.startRun({
  agentId: 'crashy',
  input: '[fixture:leftoverhang] hold',
  turnId: 'turn-crash',
})
// READY once the tool the CLI left running is recorded as a member of the run's group (it is noted every 100 ms). Killed
// earlier, the next start couldn't prove the tool is Score's and would rightly leave it alone, so what the test checks
// would depend on timing. The CLI itself dies with the server (parent-death signal); only that tool outlives the crash.
const timer = setInterval(() => {
  const row = db.sqlite.prepare('SELECT run_id, pid FROM coding_processes').get() as
    { run_id: string; pid: number } | undefined
  const tool =
    row &&
    db.sqlite
      .prepare('SELECT 1 FROM coding_process_members WHERE run_id = ? AND pid != ?')
      .get(row.run_id, row.pid)
  if (row && tool) {
    clearInterval(timer)
    process.stdout.write(`READY ${row.pid}\n`)
  }
}, 50)
setInterval(() => undefined, 1000)
