import { execFile } from 'node:child_process'

export function notifyWatchdog(spec) {
  if (!spec.notifyBin) return () => undefined
  let pending = false
  return () => {
    if (pending) return
    pending = true
    // systemd-notify is spawned from the control loop (design section 1): a hung loop stops pinging.
    execFile(spec.notifyBin, ['WATCHDOG=1'], { timeout: 2000, env: process.env }, () => {
      pending = false
    })
  }
}
