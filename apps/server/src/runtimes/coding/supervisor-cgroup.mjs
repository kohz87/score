import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The real cgroup boundary: the unit's own cgroup (from /proc/self/cgroup) and its `payload/` child. Injected in tests
 * that run without systemd.
 */
export function systemdCgroup(root = '/sys/fs/cgroup') {
  const own = readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .map((line) => /^0::(\/.*)$/.exec(line))
    .find(Boolean)?.[1]
  if (!own) throw new Error('not on cgroup v2')
  const unitDir = join(root, own)
  const payloadDir = join(unitDir, 'payload')
  return {
    /** The cgroup path reported in `ready` (relative to the cgroup root, as the kernel names it). */
    path: own,
    unitDir,
    payloadDir,
    prepare() {
      mkdirSync(payloadDir, { recursive: false })
      return payloadDir
    },
    /** 'empty' | 'populated' | 'unknown'. `populated` is recursive, so it covers descendants and setsid survivors. */
    payloadState() {
      try {
        const m = /^populated (\d)$/m.exec(readFileSync(join(payloadDir, 'cgroup.events'), 'utf8'))
        return m ? (m[1] === '0' ? 'empty' : 'populated') : 'unknown'
      } catch {
        return 'unknown'
      }
    },
    /** True when the unit cgroup holds nothing but the supervisor itself (and its payload subgroup is not counted). */
    unitAlone() {
      try {
        const pids = readFileSync(join(unitDir, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)
        return pids.every((p) => p === String(process.pid))
      } catch {
        return false
      }
    },
    /** cgroup.kill (kernel 5.14+) kills every process of the payload atomically; false when unavailable. */
    killPayload() {
      try {
        writeFileSync(join(payloadDir, 'cgroup.kill'), '1')
        return true
      } catch {
        return false
      }
    },
  }
}
