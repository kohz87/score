import { readdirSync, readFileSync } from 'node:fs'

/**
 * Process ids whose session is `sid` (the shell's own pid: node-pty makes it a session leader). Interactive shells put
 * every job in a process group of its own, so signalling the shell's group alone leaves background jobs running when
 * the shell does not hang them up in time. Linux only (/proc); elsewhere the shell's group is all there is.
 */
export function sessionMembers(sid: number): { pid: number; pgid: number }[] {
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return []
  }
  const members: { pid: number; pgid: number }[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      // "pid (comm) state ppid pgrp session ...": comm may hold spaces and parentheses, so cut after the last ")".
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[3]) === sid) members.push({ pid: Number(name), pgid: Number(fields[2]) })
    } catch {
      // Exited while we looked.
    }
  }
  return members
}
