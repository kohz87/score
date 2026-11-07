import { expect, test } from 'vitest'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import { script, setupProcessTestLifecycle } from './coding-process-helpers.ts'

setupProcessTestLifecycle()

test('#9: a final stdout line with no newline is no record: the stream is incomplete and nothing parses it', async () => {
  const lines: string[] = []
  const run = spawnCli({
    ...script(`process.stdout.write('{"ok":1}\\n{"result":"success"}')`),
    parser: {
      parse: (line: string) => {
        lines.push(line)
        return []
      },
      stats: { unknown: 0, malformed: 0 },
    },
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.exitCode).toBe(0)
  expect(lines).toEqual(['{"ok":1}'])
  expect(outcome.streamComplete).toBe(false)
  expect(outcome.streamLoss).toContain('partial-last-line')
}, 30_000)

test('#9: an oversized record is a dropped record and the stream is incomplete', async () => {
  const run = spawnCli({
    ...script(`process.stdout.write('x'.repeat(1100 * 1024) + '\\n{"a":1}\\n')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.streamComplete).toBe(false)
  expect(outcome.streamLoss).toContain('dropped-record')
}, 30_000)

test('#9: a clean stream is complete', async () => {
  const run = spawnCli({
    ...script(`process.stdout.write('{"a":1}\\n')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome).toMatchObject({ streamComplete: true, streamLoss: [] })
}, 30_000)

test('#5: stderr keeps its start and is redacted whole: a labelled long value never leaks', async () => {
  const run = spawnCli({
    ...script(`process.stderr.write('password=' + 'v'.repeat(10000) + '\\n')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.stderr).not.toMatch(/v{20}/)
}, 30_000)

test('#5: stderr past the raw limit is dropped, not kept as a tail', async () => {
  const run = spawnCli({
    ...script(`process.stderr.write('head ' + 'a'.repeat(200000) + ' TAILMARK')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.stderr.startsWith('head ')).toBe(true)
  expect(outcome.stderr).not.toContain('TAILMARK')
}, 30_000)

test('FW #7: a pipe destroyed because a descendant outside the group holds it open is forced loss, not a complete stream', async () => {
  const run = spawnCli({
    ...script(
      // A descendant in its own session keeps stdout open past the turn, then ends by itself.
      `const { spawn } = require('node:child_process');
       const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
       holder.unref();
       process.stdout.write('{"result":"success"}\\n')`,
    ),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.exitCode).toBe(0)
  expect(outcome.streamComplete).toBe(false)
  expect(outcome.streamLoss).toContain('forced-stdout-close')
}, 30_000)
