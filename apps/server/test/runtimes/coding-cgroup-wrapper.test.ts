import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { PDEATHSIG_SCRIPT } from '../../src/runtimes/coding/pdeathsig-exec.ts'

// 7.7a part 2 (design 1, payload subgroup): the exec wrapper's --cgroup <dir>. Fake cgroup = a directory with a
// regular cgroup.procs file; the real kernel behaviour is covered by the opt-in systemd suite.

// The gate fd 3 is a pipe holding "g" for the launcher; the parent check needs PARENTPID to be the spawning process.
function launch(args: string[], gate = 'g') {
  return spawnSync(
    'sh',
    [
      '-c',
      `printf '%s' "$GATE" | exec /usr/bin/python3 -I "$0" "$$" 3<&0 ${args.map((a) => `'${a}'`).join(' ')}`,
      PDEATHSIG_SCRIPT,
    ],
    { env: { GATE: gate, PATH: process.env['PATH']! }, encoding: 'utf8' },
  )
}

test('--cgroup: the launcher writes its own pid to cgroup.procs, then execs; the command sees the same pid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-wcg-'))
  writeFileSync(join(dir, 'cgroup.procs'), '')
  const r = launch(['3', '--cgroup', dir, '--', '/bin/sh', '-c', 'echo $$'])
  // Argument 2 is the gate fd; pid check: sh -c "echo $$" prints the exec'd pid == the pid the launcher wrote.
  expect(r.status).toBe(0)
  expect(readFileSync(join(dir, 'cgroup.procs'), 'utf8')).toBe(r.stdout.trim())
})

test('--cgroup: if the cgroup cannot be entered the command is NOT run (exit 6)', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'score-wcg-')), 'ran')
  const r = launch([
    '3',
    '--cgroup',
    '/nonexistent-cgroup-dir',
    '--',
    '/bin/sh',
    '-c',
    `touch ${marker}`,
  ])
  expect(r.status).toBe(6)
  expect(existsSync(marker)).toBe(false)
})

test('--cgroup needs an absolute directory and a command; the old form still works', () => {
  expect(launch(['3', '--cgroup', 'rel', '--', '/bin/true']).status).toBe(5)
  expect(launch(['3', '--cgroup', '/tmp', '--']).status).toBe(5)
  expect(launch(['3', '--', '/bin/sh', '-c', 'exit 0']).status).toBe(0)
})
