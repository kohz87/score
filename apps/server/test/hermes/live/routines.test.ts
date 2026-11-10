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
      // `--pin` locks the profile's current model onto the job (Hermes `cron edit --pin`).
      if (arg === '--pin') job.model = 'example-model'
      if (arg.startsWith('--name=')) job.name = arg.slice(7)
      if (arg.startsWith('--model=')) job.model = arg.slice(8) || null
      if (arg.startsWith('--provider=')) job.provider = arg.slice(11) || null
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

test('pinning keeps the jobs that follow the agent on its current model, and leaves pinned ones alone', async () => {
  const jobs = readJobs()
  jobs[1]!.model = 'deep-model'
  writeJobs(jobs)
  expect(routines.list('builder').map((routine) => routine.model ?? null)).toEqual([
    null,
    'deep-model',
  ])
  expect(await routines.pinFollowing('builder')).toEqual(['builder:a1b2c3d4e5f6'])
  expect(call(0)).toEqual([
    ['-p', 'builder', 'cron', 'edit', '--pin', '--', 'a1b2c3d4e5f6'],
    opts(),
  ])
  expect(runner).toHaveBeenCalledTimes(1)
  expect(routines.list('builder').map((routine) => routine.model)).toEqual([
    'example-model',
    'deep-model',
  ])
  // Nothing left to pin: no Hermes call.
  expect(await routines.pinFollowing('builder')).toEqual([])
  expect(runner).toHaveBeenCalledTimes(1)
})

test('a pin Hermes refuses stops there, and says so', async () => {
  runner.mockImplementation(async () => ({ exitCode: 1 }))
  await expect(routines.pinFollowing('builder')).rejects.toMatchObject({ status: 409 })
})

test('decision 183: create sends the model, provider and time zone; edit renames, pins and unpins', async () => {
  const routine = await routines.create(
    'builder',
    {
      title: 'Digest',
      schedule: '0 8 * * *',
      prompt: 'Sum up.',
      timezone: 'Asia/Singapore',
      model: { model: 'deep-model', provider: 'local' },
    },
    'k9',
    db,
  )
  expect(call(0)[0]).toEqual([
    '-p',
    'builder',
    'cron',
    'create',
    '--name=Digest',
    '--timezone=Asia/Singapore',
    '--model=deep-model',
    '--provider=local',
    '--',
    '0 8 * * *',
    'Sum up.',
  ])
  await routines.patch(routine.id, { title: 'Daily digest', model: null })
  expect(call(1)[0]).toEqual([
    '-p',
    'builder',
    'cron',
    'edit',
    '--name=Daily digest',
    '--model=',
    '--provider=',
    '--',
    routine.id.split(':')[1],
  ])
  expect(routines.list('builder').find((one) => one.id === routine.id)).toMatchObject({
    title: 'Daily digest',
    model: null,
    provider: null,
  })
})

test('decision 183: moving makes the job for the other agent from its full prompt, then removes it here', async () => {
  fs.mkdirSync(join(home, 'profiles', 'lead', 'cron'), { recursive: true })
  fs.writeFileSync(
    join(home, 'profiles', 'lead', 'cron', 'jobs.json'),
    JSON.stringify({ jobs: [] }),
  )
  const leadJobs = () =>
    JSON.parse(fs.readFileSync(join(home, 'profiles', 'lead', 'cron', 'jobs.json'), 'utf8')).jobs
  runner.mockImplementation(async (args) => {
    if (args[1] === 'lead' && args[3] === 'create') {
      const rest = args.slice(4)
      const [schedule, prompt] = rest.slice(rest.indexOf('--') + 1)
      const jobs = leadJobs()
      jobs.push({
        id: 'moved1',
        name: rest.find((a) => a.startsWith('--name='))!.slice(7),
        prompt,
        schedule_display: schedule,
        enabled: true,
      })
      fs.writeFileSync(
        join(home, 'profiles', 'lead', 'cron', 'jobs.json'),
        JSON.stringify({ jobs }),
      )
      return { exitCode: 0 }
    }
    return { exitCode: hermes(args) }
  })
  const full = readJobs()[0]!.prompt as string
  const moved = await routines.move('builder:a1b2c3d4e5f6', 'lead', 'm1', db)
  expect(moved).toMatchObject({
    leftBehind: null,
    job: { id: 'lead:moved1', title: 'Morning digest' },
  })
  expect(leadJobs()[0].prompt).toBe(full)
  expect(readJobs().some((job) => job.id === 'a1b2c3d4e5f6')).toBe(false)
})

test('decision 183: a move whose removal fails leaves both and says which', async () => {
  fs.mkdirSync(join(home, 'profiles', 'lead', 'cron'), { recursive: true })
  fs.writeFileSync(
    join(home, 'profiles', 'lead', 'cron', 'jobs.json'),
    JSON.stringify({ jobs: [] }),
  )
  runner.mockImplementation(async (args) => {
    if (args[1] === 'lead' && args[3] === 'create') {
      fs.writeFileSync(
        join(home, 'profiles', 'lead', 'cron', 'jobs.json'),
        JSON.stringify({
          jobs: [
            { id: 'moved2', name: 'Morning digest', prompt: readJobs()[0]!.prompt, enabled: true },
          ],
        }),
      )
      return { exitCode: 0 }
    }
    if (args[3] === 'remove') return { exitCode: 1 }
    return { exitCode: hermes(args) }
  })
  const moved = await routines.move('builder:a1b2c3d4e5f6', 'lead', 'm2', db)
  expect(moved.leftBehind).toBe('builder:a1b2c3d4e5f6')
  expect(readJobs().some((job) => job.id === 'a1b2c3d4e5f6')).toBe(true)
})

test('decision 183: a move carries what the job does (skills, results lane, work folder) and a paused job stays paused', async () => {
  fs.mkdirSync(join(home, 'profiles', 'lead', 'cron'), { recursive: true })
  fs.writeFileSync(
    join(home, 'profiles', 'lead', 'cron', 'jobs.json'),
    JSON.stringify({ jobs: [] }),
  )
  const jobs = readJobs()
  Object.assign(jobs[1]!, { skills: ['release-notes'], deliver: 'telegram', workdir: '/srv/app' })
  writeJobs(jobs)
  runner.mockImplementation(async (args) => {
    if (args[1] === 'lead' && args[3] === 'create') {
      fs.writeFileSync(
        join(home, 'profiles', 'lead', 'cron', 'jobs.json'),
        JSON.stringify({
          jobs: [
            {
              id: 'moved3',
              name: 'Dependency check',
              prompt: 'Check for outdated dependencies.',
              enabled: false,
            },
          ],
        }),
      )
      return { exitCode: 0 }
    }
    return { exitCode: hermes(args) }
  })
  await routines.move('builder:0f1e2d3c4b5a', 'lead', 'm3', db)
  const create = runner.mock.calls.find(([args]) => args[1] === 'lead' && args[3] === 'create')![0]
  expect(create).toEqual(
    expect.arrayContaining([
      '--deliver=telegram',
      '--skill=release-notes',
      '--workdir=/srv/app',
      '--paused',
    ]),
  )
  expect(create.indexOf('--paused')).toBeLessThan(create.indexOf('--'))
})

test('decision 183: a job that runs a script is not moved', async () => {
  const jobs = readJobs()
  Object.assign(jobs[0]!, { script: 'check.sh' })
  writeJobs(jobs)
  await expect(routines.move('builder:a1b2c3d4e5f6', 'lead', 'm4', db)).rejects.toMatchObject({
    status: 409,
  })
})
