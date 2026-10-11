import { readdirSync, readFileSync } from 'node:fs'

/** /proc/<pid>/stat after the command name: [state, ppid, pgrp, session, …]. null when the process is gone or /proc is missing. */
function statFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command name is in parentheses and may contain spaces or parentheses itself.
    return stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(' ')
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
  /** Fields of /proc/<pid>/stat after the command name, or null when there is no such process. */
  stat(pid: number): string[] | null
  /** Every pid in the process table, or null when it can't be listed (no /proc). */
  pids(): number[] | null
  kill(pid: number, signal: NodeJS.Signals): void
  bootId(): string | null
}
export const realProcEnv: ProcEnv = {
  stat: statFields,
  pids() {
    try {
      return readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
    } catch {
      return null
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  bootId,
}

/** Live processes of group `pgid` that started no earlier than `since` ticks (the leader's own start). */
export function groupMembers(pgid: number, since: number): number[] {
  const members: number[] = []
  for (const pid of realProcEnv.pids() ?? []) {
    const fields = statFields(pid)
    if (!fields || fields[0] === 'Z') continue
    if (Number(fields[2]) === pgid && Number(fields[19]) >= since) members.push(pid)
  }
  return members
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface RecordedGroup {
  pid: number
  pgid: number
  startTime: string | null
  /** The boot the process was recorded in; null for rows written before boots were recorded. */
  bootId: string | null
}
/** `gone` is the only proof that the work ended. */
export type GroupOutcome = 'gone' | 'alive' | 'unobservable'

type Inspection =
  | { state: 'gone' }
  | { state: 'unobservable' }
  | { state: 'ours'; leader: boolean; members: number[] }

/**
 * What is left of a recorded group, and whether it is provably ours. The pgid number alone is never enough: once a
 * group empties the kernel may hand the number to a new, unrelated group.
 *  - Another boot: everything of that boot is gone by definition.
 *  - The recorded pid still names a process: it is the recorded leader only if the start time matches (a zombie leader
 *    still holds the pid, so the group number can't have been reused either). A different process holding that pid
 *    means our group emptied before the number was reused (Linux never allocates a pid equal to a live pgid): ours is
 *    gone and the newcomer is not ours to signal.
 *  - No process holds the pid: members still in the pgid are ours, for the same reason.
 */
function inspect(record: RecordedGroup, env: ProcEnv): Inspection {
  const current = env.bootId()
  if (record.bootId !== null) {
    if (current === null) return { state: 'unobservable' }
    if (current !== record.bootId) return { state: 'gone' }
  }
  const all = env.pids()
  if (all === null) return { state: 'unobservable' }
  const holder = env.stat(record.pid)
  const members = () => {
    const found: number[] = []
    for (const pid of all) {
      const fields = env.stat(pid)
      if (fields && fields[0] !== 'Z' && Number(fields[2]) === record.pgid) found.push(pid)
    }
    return found
  }
  if (holder) {
    if (record.startTime === null) return { state: 'unobservable' }
    if (holder[19] !== record.startTime) return { state: 'gone' }
    const live = holder[0] !== 'Z'
    return { state: 'ours', leader: live, members: members() }
  }
  // Nobody holds the pid. Without a recorded boot id a surviving member can't be tied to this record: if there is
  // one we can't tell, otherwise there is nothing.
  const found = members()
  if (found.length === 0) return { state: 'gone' }
  if (record.bootId === null) return { state: 'unobservable' }
  return { state: 'ours', leader: false, members: found }
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
  const alive = (found: Inspection) =>
    found.state === 'ours' && (found.leader || found.members.length > 0)
  let found = inspect(record, env)
  if (found.state !== 'ours') return found.state
  if (!alive(found)) return 'gone'
  const signal = (name: NodeJS.Signals) => {
    const now = inspect(record, env)
    if (now.state !== 'ours') return
    if (now.leader) {
      try {
        env.kill(-record.pgid, name)
      } catch {
        // gone meanwhile, or not ours to signal: the next inspection says which
      }
    }
    for (const pid of now.members) {
      try {
        env.kill(pid, name)
      } catch {
        // gone meanwhile
      }
    }
  }
  const settle = async (ms: number) => {
    const until = Date.now() + ms
    do {
      found = inspect(record, env)
      if (!alive(found)) return
      await sleep(50)
    } while (Date.now() < until)
    found = inspect(record, env)
  }
  signal('SIGTERM')
  await settle(graceMs)
  if (alive(found)) {
    signal('SIGKILL')
    await settle(graceMs)
  }
  // `found` is reassigned inside `settle`, which flow analysis can't see.
  const last = found as Inspection
  if (last.state === 'unobservable') return 'unobservable'
  return alive(last) ? 'alive' : 'gone'
}
