import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { z } from 'zod'

const fixture = z
  .object({ cli: z.string(), features: z.array(z.string()) })
  .parse(
    JSON.parse(
      readFileSync(z.string().min(1).parse(process.env.SCORE_FINGERPRINT_FIXTURE), 'utf8'),
    ),
  )

// The preload prevents a subprocess smoke test from contacting or executing a live Hermes.
const fixtureExecFile = Object.assign(
  () => {
    throw new Error('The fixture expects a promisified CLI invocation')
  },
  { __promisify__: childProcess.execFile.__promisify__ },
)
Object.defineProperty(fixtureExecFile, promisify.custom, {
  value: async (file: string, args: string[], options: { timeout: number }) => {
    assert.equal(file, 'hermes')
    assert.deepEqual(args, ['--version'])
    assert.equal(options.timeout, 5_000)
    return { stdout: `${fixture.cli}\nFixture install details\n`, stderr: '' }
  },
})
childProcess.execFile = fixtureExecFile
syncBuiltinESMExports()
globalThis.fetch = async (input, init) => {
  assert.equal(new URL(String(input)).pathname, '/v1/capabilities')
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer default-fixture-key')
  return Response.json({
    features: Object.fromEntries(fixture.features.map((name) => [name, true])),
  })
}
