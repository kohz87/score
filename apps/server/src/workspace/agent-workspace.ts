import type { WorkspaceInfo } from '@score/contract'
import type { Config } from '../config.ts'
import { HttpError } from '../errors.ts'
import { resolveHermesHome, type HermesPort } from '../hermes/index.ts'
import { checkRoot, defaultRootPolicy, type RootPolicy } from './policy.ts'
import { Workspace, type WriteEvent } from './workspace.ts'

export interface AgentWorkspaces {
  info(agentId: string): Promise<WorkspaceInfo & { cwd: string | null }>
  /**
   * Opens the agent's workspace; throws 409 `workspace_unavailable` with the reason when it has none. `checkRoot` sees
   * the resolved root first (the Workspace routes refuse a root that changed since the page showed it).
   */
  open(
    agentId: string,
    onWrite?: (event: WriteEvent) => void,
    checkRoot?: (root: string) => void,
  ): Promise<Workspace>
}

// The agent's working folder comes from the adapter; every path rule lives in ./workspace.ts. Shared by the
// Workspace routes and by chat attachments, so both apply the same root checks.
export function createAgentWorkspaces(
  port: HermesPort,
  { home, hermesHome }: Pick<Config, 'home' | 'hermesHome'>,
  policy: RootPolicy = defaultRootPolicy([
    home,
    resolveHermesHome(hermesHome),
    resolveHermesHome(),
  ]),
): AgentWorkspaces {
  async function info(agentId: string): Promise<WorkspaceInfo & { cwd: string | null }> {
    const { cwd, backend } = await port.readWorkspaceConfig(agentId)
    if (backend !== null && backend.trim() !== '' && backend.trim().toLowerCase() !== 'local')
      return {
        root: null,
        available: false,
        reason: `This agent works on a remote terminal (${backend.replace(/[^\w.-]/g, '').slice(0, 40)}), so its files aren’t on this machine.`,
        cwd,
      }
    if (cwd === null || cwd.trim() === '' || cwd.trim() === '.')
      return {
        root: null,
        available: false,
        reason: 'No workspace folder is set for this agent.',
        cwd,
      }
    const checked = await checkRoot(cwd, policy)
    if (!checked.ok) return { root: null, available: false, reason: checked.reason, cwd }
    return { root: checked.real, available: true, reason: null, cwd }
  }

  async function open(
    agentId: string,
    onWrite?: (event: WriteEvent) => void,
    checkResolved?: (root: string) => void,
  ): Promise<Workspace> {
    const state = await info(agentId)
    if (!state.available || state.root === null)
      throw new HttpError(
        409,
        'workspace_unavailable',
        state.reason ?? 'The workspace is unavailable.',
      )
    checkResolved?.(state.root)
    return Workspace.open(state.root, policy, onWrite)
  }
  return { info, open }
}
