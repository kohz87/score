import type { Runtime } from '@score/contract'

const labels: Record<Runtime, string> = {
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
}

/** The runtime's name for a badge, or null for Hermes agents (the default, shown as nothing). */
export function runtimeLabel(runtime: Runtime | undefined): string | null {
  return runtime && runtime !== 'hermes' ? labels[runtime] : null
}
