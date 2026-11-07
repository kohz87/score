import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Trigger } from '@score/contract'
import { z } from 'zod'
import type { Sealer } from '../../auth/sealing.ts'
import { HttpError } from '../../errors.ts'
import { parseArgsTemplate } from './report-back.ts'
import { context, live, row, RowSchema, toTrigger } from './trigger-rows.ts'
import { newWebhookSecret } from './signature.ts'

// A trigger's lifecycle: listing, creation with its retry answer, update, deletion, and secret read/rotation.

/** How long a repeated, identical create is taken for a retry of the first. */
const RETRY_MINUTES = 10

export function listTriggers(sqlite: DatabaseSync, origin: string | null): Trigger[] {
  return z
    .array(RowSchema)
    .parse(
      sqlite
        .prepare('SELECT * FROM triggers WHERE deleted_at IS NULL ORDER BY created_at, id')
        .all(),
    )
    .map((item) => toTrigger(item, origin))
}

/** 3.6.0: a trigger's team must be a team room (null: the first one). */
function assertTeamRoom(sqlite: DatabaseSync, roomId: string | null | undefined): void {
  if (!roomId) return
  if (
    !sqlite
      .prepare("SELECT 1 FROM rooms WHERE id = ? AND role = 'team' AND archived = 0")
      .get(roomId)
  )
    throw new HttpError(400, 'bad_request', 'Choose one of your teams.')
}

export function createTrigger(
  sqlite: DatabaseSync,
  seal: Sealer,
  req: Pick<Trigger, 'name' | 'app' | 'mapping' | 'template' | 'reportBack'> & {
    teamRoomId?: string | null
  },
  origin: string | null,
  now: string,
): { trigger: Trigger; secret: string } {
  if (req.reportBack.mode !== 'off') parseArgsTemplate(req.reportBack.args)
  assertTeamRoom(sqlite, req.teamRoomId)
  // A create that is retried (the first answer was lost) must not leave a second trigger nobody knows: the same request
  // within a few minutes, on a trigger nobody has called yet, answers with that trigger and its secret again.
  const since = new Date(Date.parse(now) - RETRY_MINUTES * 60_000).toISOString()
  const same = z.array(RowSchema).parse(
    sqlite
      .prepare(
        `SELECT * FROM triggers WHERE deleted_at IS NULL AND last_called_at IS NULL AND created_at >= ?
             AND name = ? AND app = ? AND mapping = ? AND template = ? AND report_back = ? AND team_room_id IS ?`,
      )
      .all(
        since,
        req.name,
        req.app,
        JSON.stringify(req.mapping),
        req.template,
        JSON.stringify(req.reportBack),
        req.teamRoomId ?? null,
      ),
  )[0]
  if (same) {
    const again = seal.unseal(same.secret_sealed, context(same.id))
    if (again) return { trigger: toTrigger(same, origin), secret: again }
  }
  const id = `trg_${randomBytes(12).toString('hex')}`
  const secret = newWebhookSecret()
  sqlite
    .prepare(
      `INSERT INTO triggers (id, name, app, secret_sealed, mapping, template, report_back, created_at, updated_at, team_room_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      req.name,
      req.app,
      seal.seal(secret, context(id)),
      JSON.stringify(req.mapping),
      req.template,
      JSON.stringify(req.reportBack),
      now,
      now,
      req.teamRoomId ?? null,
    )
  return { trigger: toTrigger(row(sqlite, id)!, origin), secret }
}

export function updateTrigger(
  sqlite: DatabaseSync,
  id: string,
  change: Partial<
    Pick<Trigger, 'name' | 'app' | 'mapping' | 'template' | 'reportBack' | 'teamRoomId'>
  >,
  origin: string | null,
  now: string,
): Trigger {
  const current = toTrigger(live(sqlite, id), origin)
  const next = { ...current, ...change }
  if (next.reportBack.mode !== 'off') parseArgsTemplate(next.reportBack.args)
  assertTeamRoom(sqlite, next.teamRoomId)
  sqlite
    .prepare(
      'UPDATE triggers SET name = ?, app = ?, mapping = ?, template = ?, report_back = ?, team_room_id = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      next.name,
      next.app,
      JSON.stringify(next.mapping),
      next.template,
      JSON.stringify(next.reportBack),
      next.teamRoomId ?? null,
      now,
      id,
    )
  return toTrigger(row(sqlite, id)!, origin)
}

/** The full secret again (a paired browser only: the route checks that). */
export function triggerSecret(sqlite: DatabaseSync, seal: Sealer, id: string): string {
  const secret = seal.unseal(live(sqlite, id).secret_sealed, context(id))
  if (!secret)
    throw new HttpError(
      500,
      'secret_unreadable',
      'This trigger’s secret can’t be read on this machine. Rotate it.',
    )
  return secret
}

export function rotateTrigger(sqlite: DatabaseSync, seal: Sealer, id: string, now: string): string {
  live(sqlite, id)
  const secret = newWebhookSecret()
  sqlite
    .prepare('UPDATE triggers SET secret_sealed = ?, updated_at = ? WHERE id = ?')
    .run(seal.seal(secret, context(id)), now, id)
  return secret
}

export function deleteTrigger(sqlite: DatabaseSync, id: string, now: string): void {
  live(sqlite, id)
  sqlite
    .prepare('UPDATE triggers SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id)
}
