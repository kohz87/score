import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const FIXTURES = fileURLToPath(new URL('../fixtures/coding/', import.meta.url))
export const FAKE_CLI = fileURLToPath(new URL('../fixtures/coding/fake-cli.mjs', import.meta.url))

/** Lines of a hand-made fixture (the marker and fake-CLI directives are dropped). */
export function fixtureLines(name: string): string[] {
  return readFileSync(`${FIXTURES}${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('{"_'))
}
