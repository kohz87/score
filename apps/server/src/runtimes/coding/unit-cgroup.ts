import { existsSync, readFileSync } from 'node:fs'
import { CGROUP_ROOT } from './unit-systemd-types.ts'

export type Population = 'populated' | 'empty' | 'absent' | 'unknown'

/** Parses `cgroup.events` (`populated 0|1` is recursive over descendants). */
export function parseCgroupEvents(text: string): Population {
  const m = /^populated (\d)$/m.exec(text)
  return m ? (m[1] === '0' ? 'empty' : 'populated') : 'unknown'
}

/** Whether a cgroup (the unit's `ControlGroup`, a path like `/user.slice/…/x.service`) still holds processes. */
export function cgroupPopulation(controlGroup: string, root = CGROUP_ROOT): Population {
  if (!controlGroup.startsWith('/') || controlGroup.split('/').includes('..')) return 'unknown'
  const dir = `${root}${controlGroup}`
  try {
    return parseCgroupEvents(readFileSync(`${dir}/cgroup.events`, 'utf8'))
  } catch (error) {
    // The directory is removed once the unit is gone, which is the "absent" proof; anything else is unreadable.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(dir)
      ? 'absent'
      : 'unknown'
  }
}
