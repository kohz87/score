import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { ProfileNameSchema } from './paths.ts'

export class CredentialsUnavailable extends Error {
  constructor(readonly profile: string) {
    super(`Credentials unavailable for ${ProfileNameSchema.parse(profile)}`)
    this.name = 'CredentialsUnavailable'
  }
}

export function readKey(scoreHome: string, profile: string): { key: string; keySha256: string } {
  const name = ProfileNameSchema.parse(profile)
  let fd: number | undefined
  try {
    fd = openSync(
      join(scoreHome, 'hermes-keys', name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const stat = fstatSync(fd)
    const mode = stat.mode & 0o7777
    if (!stat.isFile() || stat.uid !== process.getuid?.() || ![0o400, 0o600].includes(mode))
      throw new CredentialsUnavailable(name)
    const content = readFileSync(fd, 'utf8')
    const key = content.trim()
    if (!key || /[\r\n]/.test(key)) throw new CredentialsUnavailable(name)
    return { key, keySha256: createHash('sha256').update(content).digest('hex') }
  } catch {
    throw new CredentialsUnavailable(name)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function ensureGeneration(db: ScoreDb, profile: string, keySha256: string): number {
  ProfileNameSchema.parse(profile)
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(keySha256)
  return db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO credentials (profile, generation, key_sha256, updated_at)
      VALUES (?, 1, ?, ?) ON CONFLICT(profile) DO UPDATE SET
      generation = credentials.generation + CASE WHEN credentials.key_sha256 = excluded.key_sha256 THEN 0 ELSE 1 END,
      key_sha256 = excluded.key_sha256, updated_at = excluded.updated_at`,
      )
      .run(profile, keySha256, new Date().toISOString())
    return z
      .object({ generation: z.int().positive() })
      .parse(sqlite.prepare('SELECT generation FROM credentials WHERE profile = ?').get(profile))
      .generation
  })
}
