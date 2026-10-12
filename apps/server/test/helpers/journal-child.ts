// Child process for orchestration/journal-durability.test.ts. Run with Node's type stripping/transform.
import fs from 'node:fs'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { OsLock } from '../../src/locks/os-lock.ts'

const [role, dir, a, b] = process.argv.slice(2) as string[]
if (role === 'hold') {
  // Holds the journal's OS lock (synchronously) until `go` (= b) appears; the test may SIGKILL it meanwhile.
  new OsLock(dir!).runSync(() => {
    fs.writeFileSync(a!, 'x')
    while (!fs.existsSync(b!)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  })
} else if (role === 'revoke') {
  // Tries to revoke launch `a` (run r1/t1) in the journal at `dir`; `b` is touched just before the lock is requested.
  const { CodingJournal } = await import('../../src/domain/orchestration/coding-journal.ts')
  const coding = new CodingJournal(
    new ExecutionJournal(dir!, process.argv[6] ?? 'scope-x', undefined, undefined, undefined, 30_000),
  )
  fs.writeFileSync(b!, 'about to revoke')
  const result = coding.revoke(a!)
  console.log(JSON.stringify({ ok: result.ok, reason: result.ok ? null : result.reason }))
} else {
  // Appends `a` send_started entries, one per attempt.
  const journal = new ExecutionJournal(dir!, 'scope-x')
  for (let i = 0; i < Number(a); i++)
    journal.append({
      kind: 'send_started',
      attemptId: `child-${i}`,
      orchestrationId: 'o1',
      attemptKind: 'step',
      agentId: 'builder',
      generation: 1,
    })
  console.log('appended')
}
