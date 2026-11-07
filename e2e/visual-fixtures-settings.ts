import {
  ConfigSearchResponseSchema,
  ConnectionsResponseSchema,
  PluginsResponseSchema,
  ProvidersResponseSchema,
  RulesResponseSchema,
} from '../packages/contract/src/index.ts'
import { recorded } from './visual-fixtures-data.ts'

export const visualFixturesSettings: Record<string, unknown> = {
  '/api/settings/providers': ProvidersResponseSchema.parse(recorded['/api/settings/providers']),
  '/api/settings/connections': ConnectionsResponseSchema.parse(
    recorded['/api/settings/connections'],
  ),
  '/api/settings/plugins?agent=lead': PluginsResponseSchema.parse({
    items: [
      {
        id: 'score-bridge',
        label: 'score-bridge',
        enabled: true,
        locked: true,
        description: 'Lets Score see what this agent does.',
      },
      {
        id: 'memory-notes',
        label: 'memory-notes',
        enabled: true,
        locked: false,
        description: 'Keeps short notes between sessions.',
      },
      { id: 'image-tools', label: 'image-tools', enabled: false, locked: false, description: null },
    ],
  }),
}

export const visualFixturesRules: Record<string, unknown> = {
  '/api/settings/rules': RulesResponseSchema.parse(recorded['/api/settings/rules']),
  '/api/settings/config?q=': ConfigSearchResponseSchema.parse(recorded['/api/settings/config?q=']),
}
