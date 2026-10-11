import type { CodingDriver } from './types.ts'

// OpenCode is listed so the person sees it, but Score cannot run it yet (not installed here, no recorded event shapes).
// The driver ships disabled until the owner installs it and a recorded stream is added.
export const opencodeDriver: CodingDriver = {
  runtime: 'opencode',
  label: 'OpenCode',
  executable: 'opencode',
  testedVersions: [],
  supported: false,
  quota: 'Uses whichever provider OpenCode is signed in to.',
  promptVia: 'stdin',
  verifiedPermissions: ['read-only', 'workspace-write', 'full'],
  warning: null,
  requiresReadAck: () => false,
  parseVersion: () => null,
  buildArgs() {
    throw new Error('OpenCode is not supported yet')
  },
  createParser() {
    throw new Error('OpenCode is not supported yet')
  },
}
