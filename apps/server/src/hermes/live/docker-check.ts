import { execFile } from 'node:child_process'

/** True when a Docker daemon answers on this machine (the CLI exists and the server replies). */
export function dockerAnswers(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => resolve(!error && stdout.trim().length > 0),
    )
  })
}
