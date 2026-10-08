import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../../src/db/index.ts'
import { HttpError } from '../../../src/errors.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'
import { LiveRoutines } from '../../../src/hermes/live/routines.ts'

const fixture = fileURLToPath(new URL('../../fixtures/hermes/profiles/', import.meta.url))
let home: string
let db: ScoreDb
let routines: LiveRoutines
let nextId = 0
// Stands in for `hermes cron …`: mutates the profile's jobs file like Hermes would.
const runner = vi.fn<HermesRunner>()
const jobsPath = () => join(home, 'profiles', 'builder', 'cron', 'jobs.json')
const readJobs = (): Record<string, unknown>[] =>
  JSON.parse(fs.readFileSync(jobsPath(), 'utf8')).jobs
const writeJobs = (jobs: unknown[]) => fs.writeFileSync(jobsPath(), JSON.stringify({ jobs }))
function hermes(args: string[]): number {
  const [verb, ...rest] = args.slice(3)
  const jobs = readJobs()
  const id = rest[rest.indexOf('--') + 1]
  if (verb === 'create') {
    const name = rest.find((arg) => arg.startsWith('--name='))!.slice(7)
    const [schedule, prompt] = rest.slice(rest.indexOf('--') + 1)
    if (schedule === 'bogus') return 1
    jobs.push({
      id: `new${++nextId}`,
      name,
      prompt,
      schedule_display: schedule,
      enabled: true,
      last_run_at: null,
    })
  } else if (verb === 'edit') {
    const job = jobs.find((candidate) => candidate.id === id)!
    for (const arg of rest) {
      if (arg.startsWith('--schedule=')) job.schedule_display = arg.slice(11)
      if (arg.startsWith('--prompt=')) job.prompt = arg.slice(9)
    }
  } else if (verb === 'pause' || verb === 'resume') {
    jobs.find((candidate) => candidate.id === id)!.enabled = verb === 'resume'
  } else if (verb === 'remove') {
    jobs.splice(
      jobs.findIndex((candidate) => candidate.id === id),
      1,
    )
  } else if (verb !== 'run') return 2
  writeJobs(jobs)
  return 0
}
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-routines-'))
  fs.cpSync(join(fixture, 'default'), home, { recursive: true })
  fs.cpSync(join(fixture, 'builder'), join(home, 'profiles', 'builder'), { recursive: true })
  fs.mkdirSync(join(home, 'profiles', 'lead'), { recursive: true })
  db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../../migrations/', import.meta.url)))
  nextId = 0
  runner.mockReset().mockImplementation(async (args) => ({ exitCode: hermes(args) }))
  routines = new LiveRoutines(home, runner)
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})
const opts = () => ({ timeoutMs: 15000, hermesHome: home })
const call = (index: number) => runner.mock.calls[index]!
const create = (key = 'k1', prompt = 'Check the build.') =>
  routines.create('builder', { title: 'Build check', schedule: 'every 2h', prompt }, key, db)

test('lists the jobs of a profile, empty without a jobs file, 404 for an unknown agent', () => {
  expect(routines.list('builder').map((routine) => routine.id)).toEqual([
    'builder:a1b2c3d4e5f6',
    'builder:0f1e2d3c4b5a',
  ])
  expect(routines.list('lead')).toEqual([])
  expect(() => routines.list('ghost')).toThrow(HttpError)
})

test('create sends exact argv, then reads the new job back', async () => {
  const routine = await create()
  expect(routine).toMatchObject({
    id: 'builder:new1',
    title: 'Build check',
    schedule: 'every 2h',
    description: 'Check the build.',
    enabled: true,
  })
  expect(call(0)).toEqual([
    ['-p', 'builder', 'cron', 'create', '--name=Build check', '--', 'every 2h', 'Check the build.'],
    opts(),
  ])
})

test('a retried create with the same key does not run Hermes again', async () => {
  const first = await create()
  const again = await create()
  expect(again).toEqual(first)
  expect(runner).toHaveBeenCalledTimes(1)
  expect(readJobs()).toHaveLength(4)
  await expect(create('k1', 'A different prompt.')).rejects.toMatchObject({
    code: 'idempotency_conflict',
  })
})

test('a create that timed out but made the job is reconciled by name and prompt on retry', async () => {
  runner.mockImplementationOnce(async (args) => {
    hermes(args)
    return { exitCode: -1 }
  })
  await expect(create()).rejects.toMatchObject({ status: 502 })
  expect(readJobs()).toHaveLength(4)
  const routine = await create()
  expect(routine.id).toBe('builder:new1')
  expect(runner).toHaveBeenCalledTimes(1)
  expect(readJobs()).toHaveLength(4)
})

test('a create that never reached Hermes is sent again on retry', async () => {
  runner.mockResolvedValueOnce({ exitCode: -1 })
  await expect(create()).rejects.toMatchObject({ status: 502 })
  expect((await create()).id).toBe('builder:new1')
  expect(runner).toHaveBeenCalledTimes(2)
})

test('a rejected create fails with 409 and is not retried under the same key', async () => {
  await expect(
    routines.create('builder', { title: 'x', schedule: 'bogus', prompt: 'y' }, 'k2', db),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    routines.create('builder', { title: 'x', schedule: 'bogus', prompt: 'y' }, 'k2', db),
  ).rejects.toMatchObject({ status: 409 })
  expect(runner).toHaveBeenCalledTimes(1)
})

test('patch maps fields to edit, pause and resume with exact argv', async () => {
  const id = 'builder:a1b2c3d4e5f6'
  const patched = await routines.patch(id, {
    schedule: 'every 4h',
    prompt: '--new prompt',
    enabled: false,
  })
  expect(patched).toMatchObject({
    schedule: 'every 4h',
    description: '--new prompt',
    enabled: false,
  })
  expect(call(0)).toEqual([
    [
      '-p',
      'builder',
      'cron',
      'edit',
      '--schedule=every 4h',
      '--prompt=--new prompt',
      '--',
      'a1b2c3d4e5f6',
    ],
    opts(),
  ])
  expect(call(1)).toEqual([['-p', 'builder', 'cron', 'pause', '--', 'a1b2c3d4e5f6'], opts()])
  await routines.patch(id, { enabled: false })
  expect(runner).toHaveBeenCalledTimes(2)
  expect((await routines.patch(id, { enabled: true })).enabled).toBe(true)
  expect(call(2)).toEqual([['-p', 'builder', 'cron', 'resume', '--', 'a1b2c3d4e5f6'], opts()])
})

test('run and remove send exact argv; unknown or malformed ids are 404 before any command', async () => {
  await routines.run('builder:a1b2c3d4e5f6')
  expect(call(0)).toEqual([['-p', 'builder', 'cron', 'run', '--', 'a1b2c3d4e5f6'], opts()])
  await routines.remove('builder:0f1e2d3c4b5a')
  expect(call(1)).toEqual([['-p', 'builder', 'cron', 'remove', '--', '0f1e2d3c4b5a'], opts()])
  expect(readJobs().map((job) => job.id)).toEqual(['a1b2c3d4e5f6', undefined])
  for (const id of ['builder:missing', 'nonsense', 'builder:-rf', '../x:abc'])
    await expect(routines.run(id)).rejects.toMatchObject({ status: 404 })
  expect(runner).toHaveBeenCalledTimes(2)
})

test('a failing mutation maps to 409 and an unreachable CLI to 502', async () => {
  runner.mockResolvedValueOnce({ exitCode: 1 })
  await expect(routines.run('builder:a1b2c3d4e5f6')).rejects.toMatchObject({ status: 409 })
  runner.mockRejectedValueOnce(new Error('spawn'))
  await expect(routines.remove('builder:a1b2c3d4e5f6')).rejects.toMatchObject({ status: 502 })
})
