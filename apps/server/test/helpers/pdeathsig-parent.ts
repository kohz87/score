// A harmless stand-in for Score for runtimes/coding-pdeathsig.test.ts: starts one sleeping "CLI" through spawnCli,
// records its pid, then waits to be killed. Run with Node's type stripping/transform.
import fs from 'node:fs'
import { spawnCli } from '../../src/runtimes/coding/process.ts'

const [pidFile, ready] = process.argv.slice(2) as string[]
spawnCli({
  file: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  cwd: process.cwd(),
  env: { PATH: process.env['PATH'] ?? '' },
  stdin: '',
  parser: { parse: () => [], stats: { unknown: 0, malformed: 0 } },
  onEvent: async () => undefined,
  onSpawn: (pid) => fs.writeFileSync(pidFile!, String(pid)),
})
fs.writeFileSync(ready!, 'x')
setInterval(() => {}, 1000)
