import type { HermesCheck } from '@score/contract'
import type { HermesChild, HermesUpdateCommand } from '../live/cli.ts'
import { HermesUpdates } from '../live/updates.ts'

// 3.15.0: the update flow in fake mode, for the screens and their e2e specs. The real job logic runs against a
// simulated `hermes update` (a few lines, then exit 0) and a check that reports one changed part, so the "differs"
// result (approvals can be turned on anyway) is what fake mode shows. Nothing on the machine changes.
const LINES: Record<HermesUpdateCommand, string[]> = {
  version: ['Hermes Agent v0.22.5+3257.g557254f (2026.9.24) · stable · local 557254faa24e'],
  check: [
    '→ Update channel: main',
    '→ Fetching from origin...',
    '⚕ Update available: 12 commits behind origin/main.',
  ],
  plan: [
    'Update plan:',
    '  Running services to restart (1):',
    '    • gateway [default] pid 1766 — systemd @ 557254fa',
  ],
  run: [
    '→ Pulling updates...',
    '  ✓ Installing Python dependencies',
    '  → Backup saved: ~/.hermes/backups/hermes-backup-20261102-0947.zip',
    '✓ Update complete! (v0.22.5+3257.g557254f → v0.22.5+3269.g7a1b2c3) [main @ 7a1b2c3]',
  ],
}

export function createFakeHermesUpdates(options: { stepMs?: number } = {}): HermesUpdates {
  const stepMs = options.stepMs ?? 400
  let updated = false
  const check = async (): Promise<HermesCheck> => ({
    hash: 'f'.repeat(64),
    build: { version: '0.22.5', codeSha: updated ? '7a1b2c3' : '557254fa', fingerprint: 'fake' },
    parts: [
      { name: 'Hermes version', status: 'same', detail: '0.22.5' },
      {
        name: 'Session database schema',
        status: updated ? 'changed' : 'same',
        detail: updated ? 'The database layout differs from the tested build.' : 'Unchanged.',
      },
      { name: 'Approval functions', status: 'same', detail: 'Present' },
    ],
    compatible: !updated,
    overridable: updated,
  })
  return new HermesUpdates({
    spawn: (command, _channel, spawnOptions): HermesChild => {
      let stop = false
      const exited = (async () => {
        for (const line of LINES[command]) {
          if (stop) return -1
          await new Promise((resolve) => setTimeout(resolve, command === 'run' ? stepMs : 20))
          spawnOptions.onLine(line)
        }
        if (command === 'run') updated = true
        return 0
      })()
      return {
        exited,
        kill: () => {
          stop = true
        },
      }
    },
    idle: () => ({ idle: true, note: 'nothing running' }),
    version: async () =>
      LINES.version[0]!.replace('3257.g557254f', updated ? '3269.g7a1b2c3' : '3257.g557254f'),
    check,
    accept: async () => undefined,
    startTestRun: async () => ({ runId: 'fake-update-test' }),
    readRun: () => ({ status: 'completed', output: 'PONG', error: null }),
    diskFreeBytes: async () => 12 * 1024 ** 3,
    backupNeedsBytes: async () => 4 * 1024 ** 3,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, stepMs))),
  })
}
