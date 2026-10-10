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

/** Live processes of group `pgid` that started no earlier than `since` ticks (the leader's own start). */
function groupMembers(pgid: number, since: number): number[] {
  const members: number[] = []
  let names: string[] = []
  try {
    names = readdirSync('/proc')
  } catch {
    return members
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const fields = statFields(Number(name))
    if (!fields || fields[0] === 'Z') continue
    if (Number(fields[2]) === pgid && Number(fields[19]) >= since) members.push(Number(name))
  }
  return members
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stops what is left of a run's process group after a crash: SIGTERM, then SIGKILL. The leader is signalled as a
 * group only when it is still the recorded process; if it already died, its surviving members (started after it) are
 * signalled one by one. Returns whether anything was alive.
 */
export async function killRecordedGroup(
  record: { pid: number; pgid: number; startTime: string | null },
  graceMs = 3000,
): Promise<boolean> {
  const since = record.startTime === null ? 0 : Number(record.startTime)
  const targets = () => {
    const leader = isSameProcess(record.pid, record.startTime)
    return { leader, pids: leader ? [record.pid] : groupMembers(record.pgid, since) }
  }
  const signal = (name: NodeJS.Signals) => {
    const { leader, pids } = targets()
    if (leader) {
      try {
        process.kill(-record.pgid, name)
      } catch {
        // gone meanwhile
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, name)
      } catch {
        // gone meanwhile
      }
    }
  }
  const alive = () => {
    const { pids } = targets()
    return pids.length > 0 || groupMembers(record.pgid, since).length > 0
  }
  if (!alive()) return false
  signal('SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && alive()) await sleep(50)
  if (alive()) {
    signal('SIGKILL')
    const hard = Date.now() + graceMs
    while (Date.now() < hard && alive()) await sleep(50)
  }
  return true
}
