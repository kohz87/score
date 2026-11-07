import { HttpError } from '../../errors.ts'
import { readTerminalConfig } from './agent-config.ts'
import { AgentTabsProviders } from './agent-tabs-providers.ts'

/** Workspace folder settings for one Hermes profile. */
export abstract class AgentTabsWorkspace extends AgentTabsProviders {
  /** The agent's terminal folder and backend (Workspace tab); 502 when Hermes can't answer. */
  async readWorkspaceConfig(
    agentId: string,
  ): Promise<{ cwd: string | null; backend: string | null }> {
    const { profile } = this.profile(agentId)
    try {
      return await readTerminalConfig(this.runner, this.hermesHome, profile)
    } catch {
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read this agent from Hermes.')
    }
  }
  async setWorkspaceCwd(agentId: string, cwd: string): Promise<void> {
    const { profile } = this.profile(agentId)
    await this.serial(profile, () => this.mutate(profile, ['config', 'set', 'terminal.cwd', cwd]))
  }
}
