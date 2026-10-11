import { z } from 'zod'
import { ApprovalModeSchema } from '@score/contract'
import { HttpError } from '../../errors.ts'
import {
  updateApprovalConfig,
  type ApprovalConfig,
  type ApprovalIo,
  type ApprovalWriteKey,
} from '../approvals.ts'
import { type HermesRunner } from './cli.ts'

// Approval settings live in each profile's config.yaml. Score reads them through `hermes config get --json`
// (allowlisted in cli.ts) and writes only command_allowlist, approvals.deny and approvals.mode through
// `hermes config set`; it never opens config.yaml.
const ListSchema = z.array(z.string().min(1).max(400)).max(5000)
const ApprovalsSchema = z
  .object({
    // YAML 1.1 reads an unquoted `off` as false.
    mode: z.union([ApprovalModeSchema, z.literal(false)]).optional(),
    deny: ListSchema.nullish(),
  })
  .passthrough()
const TIMEOUT_MS = 10000

async function getJson(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
  key: 'command_allowlist' | 'approvals',
  fresh: boolean,
): Promise<unknown> {
  const result = await runner(['-p', profile, 'config', 'get', '--json', key], {
    timeoutMs: TIMEOUT_MS,
    hermesHome,
    captureRead: true,
    ...(fresh ? { fresh: true } : {}),
  }).catch(() => ({ exitCode: -1 }) as { exitCode: number; stdout?: string })
  if (result.exitCode !== 0 || !result.stdout)
    throw new HttpError(
      502,
      'hermes_unavailable',
      'Couldn’t read the approval settings from Hermes.',
    )
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new HttpError(
      502,
      'hermes_unavailable',
      'Couldn’t read the approval settings from Hermes.',
    )
  }
}

export async function readApprovalConfig(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
  fresh = false,
): Promise<ApprovalConfig> {
  const allowlist = ListSchema.nullable().safeParse(
    await getJson(runner, hermesHome, profile, 'command_allowlist', fresh),
  )
  const approvals = ApprovalsSchema.safeParse(
    await getJson(runner, hermesHome, profile, 'approvals', fresh),
  )
  if (!allowlist.success || !approvals.success)
    throw new HttpError(
      502,
      'hermes_unavailable',
      'Couldn’t read the approval settings from Hermes.',
    )
  const mode = approvals.data.mode
  return {
    mode: mode === false ? 'off' : (mode ?? 'smart'),
    allowlist: [...new Set(allowlist.data ?? [])],
    deny: [...new Set(approvals.data.deny ?? [])],
  }
}

/** The CLI side of the verified write loop for one profile. */
export function approvalIo(runner: HermesRunner, hermesHome: string, profile: string): ApprovalIo {
  const set = async (key: ApprovalWriteKey, value: string) => {
    const result = await runner(['-p', profile, 'config', 'set', key, value], {
      timeoutMs: TIMEOUT_MS,
      hermesHome,
    }).catch(() => ({ exitCode: -1 }))
    if (result.exitCode !== 0)
      throw new HttpError(
        result.exitCode < 0 ? 502 : 409,
        result.exitCode < 0 ? 'hermes_unavailable' : 'conflict',
        'Hermes didn’t accept the change.',
      )
  }
  const differs = (a: string[], b: string[]) =>
    a.length !== b.length || a.some((item) => !b.includes(item))
  return {
    // Mutations read their baseline (and verify) uncached: a cached answer may predate an outside edit.
    read: () => readApprovalConfig(runner, hermesHome, profile, true),
    async write(current, next) {
      if (differs(current.allowlist, next.allowlist))
        await set('command_allowlist', JSON.stringify(next.allowlist))
      if (differs(current.deny, next.deny)) await set('approvals.deny', JSON.stringify(next.deny))
      if (current.mode !== next.mode) await set('approvals.mode', next.mode)
    },
  }
}

export function updateProfileApprovals(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
  edit: (current: ApprovalConfig) => ApprovalConfig,
): Promise<ApprovalConfig> {
  return updateApprovalConfig(approvalIo(runner, hermesHome, profile), edit)
}
