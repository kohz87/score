import { agentCases } from './schemas-cases-agents.ts'
import { nowTaskCases } from './schemas-cases-now-tasks.ts'
import { watchStreamCases } from './schemas-cases-watch-stream.ts'
import { securitySettingsCases } from './schemas-cases-security-settings.ts'
import { workspaceCases } from './schemas-cases-workspaces.ts'
import { knowledgeCases } from './schemas-cases-knowledge.ts'
import { orchestrationCases } from './schemas-cases-orchestration.ts'
import { modelConfigCases } from './schemas-cases-model-config.ts'
import { maintenanceCases } from './schemas-cases-maintenance.ts'
import { codingCases } from './schemas-cases-coding.ts'
import { themeCases } from './schemas-cases-themes.ts'
import { exchangeCases } from './schemas-cases-exchanges.ts'
import { subagentCases } from './schemas-cases-subagents.ts'
import { chatModelCases } from './schemas-cases-chat-models.ts'

export const cases = [
  ...agentCases,
  ...subagentCases,
  ...chatModelCases,
  ...nowTaskCases,
  ...watchStreamCases,
  ...securitySettingsCases,
  ...workspaceCases,
  ...knowledgeCases,
  ...orchestrationCases,
  ...modelConfigCases,
  ...maintenanceCases,
  ...codingCases,
  ...themeCases,
  ...exchangeCases,
] as const
