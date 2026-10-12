import { readdirSync, readFileSync } from 'node:fs'
import { signalGroup, signalPid, type PidSignalResult } from './pidfd-signal.ts'

/** Fields up to the start time (index 19) must be there for a stat line to mean anything. */
const MIN_FIELDS = 20

/**
 * /proc/<pid>/stat after the command name: [state, ppid, pgrp, session, …]. null only when there is no such process
 * (ENOENT/ESRCH). Anything else (EACCES, EIO, a malformed line, no /proc at all) throws: an unreadable process is not
 * an absent one (N5).
 */
function readStat(pid: number): string[] | null {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return null
    throw error
  }
  // The command name is in parentheses and may contain spaces or parentheses itself.
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(' ')
  if (fields.length < MIN_FIELDS) throw new Error(`malformed /proc/${pid}/stat`)
  return fields
}

/** Lenient reader for callers that only want a best-effort answer: null when gone or unreadable. */
function statFields(pid: number): string[] | null {
  try {
    return readStat(pid)
  } catch {
    return null
  }
}

/** The process start time (clock ticks since boot), which together with the pid names one process for good. */
export function processStart(pid: number): string | null {
  return statFields(pid)?.[19] ?? null
}

export function procAvailable(): boolean {
  return processStart(process.pid) !== null
}

/** Whether the exact process (pid and start time) is alive. A zombie counts as gone. */
export function isSameProcess(pid: number, startTime: string | null): boolean {
  const fields = statFields(pid)
  if (!fields || fields[0] === 'Z') return false
  return startTime === null ? true : fields[19] === startTime
}

/** The boot this process table belongs to: start times and pids mean nothing across boots. null where unreadable. */
export function bootId(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
  } catch {
    return null
  }
}

/** What recovery needs from the OS. Injectable so tests can fake survivors, a reused pid or another boot. */
export interface ProcEnv {
  /** Fields of /proc/<pid>/stat after the command name; null = there is no such process; throws when unreadable. */
  stat(pid: number): string[] | null
  /** Every pid in the process table, or null when it can't be listed (no /proc). */
  pids(): number[] | null
  /**
   * Whether any process (a zombie counts) has this PGID, asked of the kernel (`kill(-pgid, 0)`). The only proof of
   * absence: 'none' is ESRCH, anything we can't read is 'unknown'.
   */
  groupExists(pgid: number): 'exists' | 'none' | 'unknown'
  /**
   * Signals the whole group through the recorded leader's pidfd, after its start time matched while the pidfd was held.
   * The group number is never used (it could have been reissued). `unavailable` = can't prove it (no python, pidfd or
   * group-flag support): nothing sent.
   */
  signalGroup(leader: number, startTime: string, signal: NodeJS.Signals): PidSignalResult
  /**
   * The only way to signal a single pid: identity (start time) is checked while a pidfd pins the process, so a reused
   * pid is never signalled. Signal 0 verifies without signalling. `unavailable` = identity can't be proven: nothing sent.
   */
  signalPid(pid: number, startTime: string, signal: NodeJS.Signals | 0): PidSignalResult
  bootId(): string | null
}
export function kernelGroupExists(pgid: number): 'exists' | 'none' | 'unknown' {
  if (!Number.isInteger(pgid) || pgid <= 1) return 'unknown'
  try {
    process.kill(-pgid, 0)
    return 'exists'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM: a member exists that we may not signal.
    if (code === 'EPERM') return 'exists'
    return code === 'ESRCH' ? 'none' : 'unknown'
  }
}
export const realProcEnv: ProcEnv = {
  stat: readStat,
  pids() {
    try {
      return readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
    } catch {
      return null
    }
  },
  groupExists: kernelGroupExists,
  signalGroup: (leader, startTime, signal) => signalGroup(leader, startTime, signal),
  signalPid: (pid, startTime, signal) => signalPid(pid, startTime, signal),
  bootId,
}

/** One process, named for good by its pid and start time. */
export interface MemberIdentity {
  pid: number
  startTime: string
}

interface Row {
  pid: number
  ppid: number
  pgrp: number
  state: string
  start: string
}
/** The process table, or null when any of it can't be read: an incomplete scan never establishes anything (N5). */
function scanTable(env: ProcEnv): Map<number, Row> | null {
  const all = env.pids()
  if (all === null) return null
  const table = new Map<number, Row>()
  for (const pid of all) {
    let fields: string[] | null
    try {
      fields = env.stat(pid)
    } catch {
      return null
    }
    if (fields === null) continue // ended since the listing
    const ppid = Number(fields[1])
    const pgrp = Number(fields[2])
    if (
      fields.length < MIN_FIELDS ||
      !Number.isInteger(ppid) ||
      !Number.isInteger(pgrp) ||
      !fields[19]
    )
      return null
    table.set(pid, { pid, ppid, pgrp, state: fields[0]!, start: fields[19] })
  }
  return table
}

/**
 * The live members of group `pgid` as identities, for recording while Score supervises the group. `complete` is false
 * when the table couldn't be read in full (what is returned is then only a part). Never proves absence.
 */
export function scanGroup(
  pgid: number,
  env: ProcEnv = realProcEnv,
): { members: MemberIdentity[]; complete: boolean } {
  const table = scanTable(env)
  if (table === null) return { members: [], complete: false }
  const members = [...table.values()]
    .filter((row) => row.pgrp === pgid && row.state !== 'Z')
    .map((row) => ({ pid: row.pid, startTime: row.start }))
  return { members, complete: true }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface RecordedGroup {
  pid: number
  pgid: number
  startTime: string | null
  /** The boot the process was recorded in; null for rows written before boots were recorded. */
  bootId: string | null
  /** Identities recorded while Score supervised the group (the continuity that lets a leaderless group be ours). */
  members?: MemberIdentity[]
  /** Called with identities newly proven ours, so they can be recorded. */
  onMembers?(members: MemberIdentity[]): void
}
/** `gone` is the only proof that the work ended. */
export type GroupOutcome = 'gone' | 'alive' | 'unobservable'

interface Target {
  pid: number
  start: string
}
type Inspection =
  | { state: 'gone' }
  | { state: 'unobservable' }
  | {
      state: 'ours'
      /** The recorded leader still holds its pid (alive or zombie): the group number is provably ours. */
      leader: boolean
      /** Live processes proven ours that may be signalled one by one (when the leader no longer vouches for the group). */
      targets: Target[]
      /** The kernel says some process still has this PGID. */
      exists: boolean
      /** A live member of the group matches nothing recorded: it may belong to a replacement group. Never signalled. */
      foreign: boolean
    }

/**
 * What is left of a recorded group, and whether it is provably ours. The pgid number alone is never enough: once a
 * group empties the kernel may hand the number to a new, unrelated group.
 *  - Another boot: everything of that boot is gone by definition.
 *  - The recorded pid still names a process: it is the recorded leader only if the start time matches (a zombie leader
 *    still holds the pid, so the group number can't have been reused either). A different process holding that pid
 *    means our group emptied before the number was reused (Linux never allocates a pid equal to a live pgid): ours is
 *    gone and the newcomer is not ours to signal.
 *  - No process holds the pid (N4): a member in the pgid may belong to a replacement group that reused the number and
 *    whose leader has exited. It is ours only through continuity: its pid and start time were recorded while Score
 *    supervised the run, or it descends from one that was. Anything else is `foreign`.
 *  - Absence is the kernel's word (`groupExists` = none), never a /proc listing's (N5).
 */
function inspect(record: RecordedGroup, env: ProcEnv, known: Map<number, string>): Inspection {
  const current = env.bootId()
  if (record.bootId !== null) {
    if (current === null) return { state: 'unobservable' }
    if (current !== record.bootId) return { state: 'gone' }
  }
  const table = scanTable(env)
  const holder = table?.get(record.pid)
  if (holder) {
    if (record.startTime === null) return { state: 'unobservable' }
    if (holder.start !== record.startTime) return { state: 'gone' }
  }
  const exists = env.groupExists(record.pgid)
  if (holder && table) {
    // `holder` matched the recorded start: the leader (alive or zombie) vouches for the whole group.
    const live = [...table.values()].filter((row) => row.pgrp === record.pgid && row.state !== 'Z')
    const found: MemberIdentity[] = []
    for (const row of live)
      if (known.get(row.pid) !== row.start) {
        known.set(row.pid, row.start)
        found.push({ pid: row.pid, startTime: row.start })
      }
    if (found.length) record.onMembers?.(found)
    if (exists === 'unknown') return { state: 'unobservable' }
    return {
      state: 'ours',
      leader: true,
      targets: live.map((row) => ({ pid: row.pid, start: row.start })),
      exists: exists === 'exists',
      foreign: false,
    }
  }
  // The leader is gone (or the table is unreadable).
  if (exists === 'none') return { state: 'gone' }
  if (exists === 'unknown' || table === null) return { state: 'unobservable' }
  const live = [...table.values()].filter((row) => row.pgrp === record.pgid && row.state !== 'Z')
  const owned: Row[] = []
  let foreign = false
  for (const row of live) {
    if (descendsFromKnown(row, table, known)) owned.push(row)
    else foreign = true
  }
  const found: MemberIdentity[] = []
  for (const row of owned)
    if (known.get(row.pid) !== row.start) {
      known.set(row.pid, row.start)
      found.push({ pid: row.pid, startTime: row.start })
    }
  if (found.length) record.onMembers?.(found)
  // The kernel says the group exists but nothing readable is in it (a fork we missed, or only zombies): not ours to
  // judge by the listing alone.
  if (live.length === 0 && ![...table.values()].some((row) => row.pgrp === record.pgid))
    return { state: 'unobservable' }
  return {
    state: 'ours',
    leader: false,
    targets: owned.map((row) => ({ pid: row.pid, start: row.start })),
    exists: true,
    foreign,
  }
}

/** The process itself, or an ancestor within reach, is a recorded identity that still matches. */
function descendsFromKnown(row: Row, table: Map<number, Row>, known: Map<number, string>): boolean {
  let at: Row | undefined = row
  for (let depth = 0; at && depth < 64; depth++) {
    if (known.get(at.pid) === at.start) return true
    if (at.ppid <= 1) return false
    at = table.get(at.ppid)
  }
  return false
}

/**
 * Stops what is left of a run's process group after a crash: SIGTERM, then SIGKILL, only for processes proven to be
 * ours (see `inspect`). Never signals by pgid alone unless the recorded leader itself is still there.
 */
export async function killRecordedGroup(
  record: RecordedGroup,
  graceMs = 3000,
  env: ProcEnv = realProcEnv,
): Promise<GroupOutcome> {
  // pid -> start time of every identity proven ours so far (the recorded ones to begin with).
  const known = new Map<number, string>()
  for (const member of record.members ?? []) known.set(member.pid, member.startTime)
  if (record.startTime !== null) known.set(record.pid, record.startTime)
  // Still worth waiting for: something of ours may yet end. A group holding only foreign members offers nothing to do.
  const alive = (found: Inspection) =>
    found.state === 'ours' && found.exists && !(found.foreign && found.targets.length === 0)
  let found = inspect(record, env, known)
  if (found.state !== 'ours') return found.state
  if (!found.exists) return 'gone'
  if (!alive(found)) return 'unobservable'
  /** Returns false when identity couldn't be proven (no pidfd support): nothing was sent and waiting won't help. */
  const signal = (name: NodeJS.Signals): boolean => {
    const now = inspect(record, env, known)
    if (now.state !== 'ours') return true
    if (now.leader) {
      // Through the leader's pidfd: identity is checked and the group signalled as one step, with no numeric kill.
      const verdict = env.signalGroup(record.pid, record.startTime!, name)
      return verdict !== 'unavailable'
    }
    let usable = true
    for (const target of now.targets) {
      // The identity is checked under a pidfd inside the helper: a pid reused since the scan is never signalled (X3, Y1).
      try {
        if (env.signalPid(target.pid, target.start, name) === 'unavailable') usable = false
      } catch {
        usable = false
      }
    }
    return usable
  }
  const settle = async (ms: number) => {
    const until = Date.now() + ms
    do {
      found = inspect(record, env, known)
      if (!alive(found)) return
      await sleep(50)
    } while (Date.now() < until)
    found = inspect(record, env, known)
  }
  if (!signal('SIGTERM')) return 'unobservable'
  await settle(graceMs)
  if (alive(found)) {
    if (!signal('SIGKILL')) return 'unobservable'
    await settle(graceMs)
  }
  // `found` is reassigned inside `settle`, which flow analysis can't see.
  const last = found as Inspection
  if (last.state === 'gone') return 'gone'
  if (last.state === 'unobservable') return 'unobservable'
  if (!last.exists) return 'gone'
  return last.foreign ? 'unobservable' : 'alive'
}
