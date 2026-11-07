import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { readCheckpoint } from '../../src/domain/orchestration/coding-checkpoint.ts'
import {
  SCOPE,
  coding,
  db,
  dir,
  id,
  journal,
  project,
  rowOf,
  setupCodingJournal,
  tmp,
  toArmed,
} from './coding-journal-helpers.ts'

// 7.7a part 1 (design v7 §2, §3): coding records, the critical section, tombstones, the DB checkpoint.

const child = fileURLToPath(new URL('../helpers/journal-child.ts', import.meta.url))

setupCodingJournal()

test('the full lifecycle journals every phase with the full state and projects it to the database', () => {
  toArmed()
  expect(coding.release('l1', () => true, project).ok).toBe(true)
  expect(coding.releasedSeen('l1', {}, project).ok).toBe(true)
  expect(coding.ended('l1', { proof: 'cgroup-empty' }, project).ok).toBe(true)
  const settled = coding.settled('l1', { disposition: 'completed' }, project)
  expect(settled.ok).toBe(true)
  const read = journal.readOwn()
  expect(read.ok && read.entries.map((e) => e.kind)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'released-seen',
    'ended',
    'settled',
  ])
  const state = coding.state('l1')!.state
  expect(state).toMatchObject({
    runId: 'r1',
    turnId: 't1',
    generation: 1,
    phase: 'settled',
    revoked: false,
    mayHaveExecuted: true,
    unit: 'score-u1',
    invocationId: 'inv1',
    cgroup: '/cg/1',
    proof: 'cgroup-empty',
    disposition: 'completed',
  })
  expect(rowOf('l1')).toMatchObject({
    phase: 'settled',
    may_have_executed: 1,
    unsendable: 1,
    journal_n: 6,
  })
  expect(readCheckpoint(db.sqlite)).toBe(6)
})

test('illegal order, repeats, identity changes and unknown launches are rejected without a record', () => {
  expect(coding.arm('l1', {}, project)).toMatchObject({ ok: false, reason: 'unknown_launch' })
  coding.requestLaunch(id(), project)
  expect(coding.requestLaunch(id(), project)).toMatchObject({
    ok: false,
    reason: 'illegal_transition',
  })
  expect(coding.release('l1', () => true, project)).toMatchObject({
    ok: false,
    reason: 'illegal_transition',
  })
  expect(coding.requestLaunch({ ...id(), runId: 'other' }, project)).toMatchObject({
    ok: false,
    reason: 'identity_mismatch',
  })
  const read = journal.readOwn()
  expect(read.ok && read.entries).toHaveLength(1)
})

test('release is refused when the run is no longer authorised (re-evaluated under the lock) and leaves no record', () => {
  toArmed()
  expect(coding.release('l1', () => false, project)).toMatchObject({
    ok: false,
    reason: 'not_authorised',
  })
  expect(coding.state('l1')!.kind).toBe('armed')
  expect(coding.state('l1')!.state.mayHaveExecuted).toBe(false)
})

test('race, revoke first: a later release fails and the launch never may-have-executed', () => {
  toArmed()
  expect(coding.revoke('l1', undefined, project).ok).toBe(true)
  expect(coding.release('l1', () => true, project)).toMatchObject({ ok: false, reason: 'revoked' })
  const state = coding.state('l1')!.state
  expect(state.revoked).toBe(true)
  expect(state.mayHaveExecuted).toBe(false)
  // A revoked launch can still be ended and settled (its unit, if any, must be proven gone).
  expect(coding.ended('l1', { proof: 'receipts' }, project).ok).toBe(true)
  expect(coding.settled('l1', { disposition: 'revoked' }, project).ok).toBe(true)
  // ...but never requested or armed again.
  expect(coding.requestLaunch(id(), project)).toMatchObject({ ok: false })
})

test('race, release first: revoke is a Stop of a possibly-executing run, never "never ran"', () => {
  toArmed()
  expect(coding.release('l1', () => true, project).ok).toBe(true)
  const revoked = coding.revoke('l1', undefined, project)
  expect(revoked).toMatchObject({ ok: false, reason: 'may_have_executed' })
  expect(coding.state('l1')!.state).toMatchObject({ revoked: false, mayHaveExecuted: true })
})

test('revoking a launch that has no record yet journals a revocation: it can never be requested afterwards', () => {
  expect(coding.revoke('l9', id(9), project).ok).toBe(true)
  expect(coding.requestLaunch(id(9), project)).toMatchObject({ ok: false, reason: 'revoked' })
})

test('the race across two processes: a revoke waiting on the lock sees the release that won', async () => {
  toArmed()
  const marker = join(tmp.dir, 'child-started')
  let exited: Promise<{ out: string }> | undefined
  const result = coding.release(
    'l1',
    () => true,
    () => {
      // Inside the critical section, after `releasing` is durable and before the lock is released: a second process
      // asks to revoke the same launch. It must wait for the lock and then find `releasing`.
      const proc = spawn(
        process.execPath,
        [
          '--experimental-transform-types',
          '--no-warnings',
          child,
          'revoke',
          dir,
          'l1',
          marker,
          SCOPE,
        ],
        {
          env: { ...process.env, XDG_STATE_HOME: join(tmp.dir, 'state') },
        },
      )
      let out = ''
      proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
      exited = new Promise((resolve) => proc.on('close', () => resolve({ out })))
      const deadline = Date.now() + 15_000
      while (!existsSync(marker) && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      // Give the child time to block on the lock.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    },
  )
  expect(result.ok).toBe(true)
  const { out } = await exited!
  expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({
    ok: false,
    reason: 'may_have_executed',
  })
  expect(coding.state('l1')!.state.revoked).toBe(false)
}, 30_000)
