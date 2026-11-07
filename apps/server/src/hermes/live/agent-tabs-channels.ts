import type { AgentChannelsResponse } from '@score/contract'
import { AgentTabsModels } from './agent-tabs-models.ts'
import { messagingRows, readProfilePlatforms } from './settings.ts'

/** Gateway channel settings for one Hermes profile. */
export abstract class AgentTabsChannels extends AgentTabsModels {
  /** Gateway state from this profile's own home; the connect command is shown, never run. */
  listChannels(agentId: string): AgentChannelsResponse {
    const { profile } = this.profile(agentId)
    return {
      items: messagingRows(readProfilePlatforms(this.hermesHome, profile)).map((row) => ({
        ...row,
        connectCommand: `hermes -p ${profile} gateway setup`,
      })),
    }
  }
}
