import { HttpError } from '../../errors.ts'
import { redact } from '../../redact.ts'
import { ToolIdSchema, type AgentTool } from '../agent-tabs.ts'
import { AgentTabsMemory } from './agent-tabs-memory.ts'
import { readTools, RUN_TOOL_PLATFORM, WORKER_TOOL_PLATFORM } from './agent-config.ts'

/** Tool listing and per-platform toggles for one Hermes profile. */
export abstract class AgentTabsTools extends AgentTabsMemory {
  async tools(agentId: string): Promise<AgentTool[]> {
    const { profile } = this.profile(agentId)
    return (await readTools(this.runner, this.hermesHome, profile)) ?? []
  }
  async setToolEnabled(agentId: string, toolId: string, enabled: boolean): Promise<AgentTool> {
    ToolIdSchema.parse(toolId)
    const { profile } = this.profile(agentId)
    return this.serial(profile, async () => {
      const tool = (await this.tools(agentId)).find((candidate) => candidate.id === toolId)
      if (!tool) throw new HttpError(404, 'not_found', 'Couldn’t find that tool.')
      if (tool.kind === 'mcp')
        throw new HttpError(
          501,
          'not_implemented',
          'MCP servers are switched on or off per tool in Hermes. Score shows them read-only.',
        )
      if (tool.enabled !== enabled) {
        const verb = enabled ? 'enable' : 'disable'
        // Kanban workers read the cli platform; a toolset that platform refuses doesn't block the change
        // for Score's own runs, which are verified below.
        await this.mutate(profile, [
          'tools',
          verb,
          '--platform',
          WORKER_TOOL_PLATFORM,
          '--',
          toolId,
        ]).catch(() => undefined)
        await this.mutate(profile, ['tools', verb, '--platform', RUN_TOOL_PLATFORM, '--', toolId])
      }
      const after = (await this.tools(agentId)).find((candidate) => candidate.id === toolId)
      if (!after || after.enabled !== enabled)
        throw new HttpError(409, 'conflict', 'Hermes didn’t apply the change.')
      return { ...after, label: redact(after.label) }
    })
  }
}
