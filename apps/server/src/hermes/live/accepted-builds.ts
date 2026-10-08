import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { TestedFingerprintSchema, type TestedFingerprint } from './fingerprint.ts'

// Builds the owner checked and accepted in Settings. Kept in $SCORE_HOME, never in the repo's tested registry.
export const AcceptedBuildSchema = TestedFingerprintSchema.extend({
  addedPatternKeys: z.array(z.string()).default([]),
})
export type AcceptedBuild = z.infer<typeof AcceptedBuildSchema>

export class AcceptedBuilds {
  private entries: AcceptedBuild[] | undefined
  private readonly path: string
  constructor(scoreHome: string) {
    this.path = join(scoreHome, 'accepted-hermes-builds.json')
  }
  list(): readonly AcceptedBuild[] {
    if (!this.entries) {
      try {
        this.entries = z
          .array(AcceptedBuildSchema)
          .parse(JSON.parse(readFileSync(this.path, 'utf8')))
      } catch {
        // Missing or unreadable means nothing is accepted; a bad file never widens trust.
        this.entries = []
      }
    }
    return this.entries
  }
  tested(): TestedFingerprint[] {
    return this.list().map(({ id, parts, testedAt, notes }) => ({ id, parts, testedAt, notes }))
  }
  patternKeys(): string[] {
    return [...new Set(this.list().flatMap((entry) => entry.addedPatternKeys))]
  }
  add(entry: AcceptedBuild): void {
    const next = [
      ...this.list().filter(({ id }) => id !== entry.id),
      AcceptedBuildSchema.parse(entry),
    ]
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.path)
    this.entries = next
  }
}
