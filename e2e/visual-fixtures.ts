import { StreamHelloSchema } from '../packages/contract/src/index.ts'
import { visualFixturesCore } from './visual-fixtures-core.ts'
import { system } from './visual-fixtures-data.ts'
import { visualFixturesKnowledge } from './visual-fixtures-knowledge.ts'
import { visualFixturesReports } from './visual-fixtures-reports.ts'
import { visualFixturesRooms } from './visual-fixtures-rooms.ts'
import { visualFixturesRules, visualFixturesSettings } from './visual-fixtures-settings.ts'
export const visualFixtures: Record<string, unknown> = {
  ...visualFixturesCore,
  ...visualFixturesRooms,
  ...visualFixturesReports,
  ...visualFixturesSettings,
  ...visualFixturesKnowledge,
  ...visualFixturesRules,
}
export const visualHello = StreamHelloSchema.parse({
  type: 'stream.hello',
  data: { epoch: 'visual-qa', headSeq: 47, mode: 'fake', system },
})
