// Throwaway "server" for the real-systemd crash test: starts one slow coding turn on the unit backend, prints
// `READY <pid of the CLI>` once the run is released, then idles until the test SIGKILLs it (a crash: no cleanup runs).
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { createIngest } from '../../src/hub/ingest.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import { insertCodingAgent } from '../../src/runtimes/coding/store.ts'
import { UnitBackend } from '../../src/runtimes/coding/unit-backend.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'

const [dir, workspace, fakeCli, runtimeDir, installationId, prefix, cliLog] = process.argv.slice(
  2,
) as [string, string, string, string, string, string, string]
mkdirSync(join(dir, 'home'), { recursive: true })
const namespace = join(dir, 'journal', installationId)
mkdirSync(join(namespace, 'launches'), { recursive: true })
const db = openDatabase(join(dir, 'score.db'))
migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
const ingest = createIngest(db)
const unit = new UnitBackend({
  db,
  journal: new CodingJournal(new ExecutionJournal(namespace, installationId)),
  installationId,
  namespaceDir: namespace,
  runtimeDir,
  home: process.env['HOME']!,
  unitPrefix: prefix,
  notifySocket: join(process.env['XDG_RUNTIME_DIR']!, 'systemd', 'notify'),
  graceMs: 500,
})
const status = await unit.start()
if (status.kind !== 'unit') {
  process.stdout.write(`NOUNIT ${JSON.stringify(status.checks.filter((c) => !c.ok))}\n`)
  process.exit(3)
}
const runtime = new CodingRuntime({
  db,
  ingest,
  unit,
  graceMs: 500,
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
await runtime.startRun({ agentId: 'crashy', input: '[fixture:slow] hold', turnId: 'turn-crash' })
const timer = setInterval(() => {
  const row = db.sqlite
    .prepare("SELECT launch_id FROM coding_launches WHERE phase IN ('releasing','released')")
    .get() as { launch_id: string } | undefined
  let pid = 0
  try {
    pid = (JSON.parse(readFileSync(cliLog, 'utf8').trim().split('\n').at(-1)!) as { pid: number })
      .pid
  } catch {
    // the CLI has not logged yet
  }
  if (row && pid) {
    clearInterval(timer)
    process.stdout.write(`READY ${pid}\n`)
  }
}, 50)
setInterval(() => undefined, 1000)
