import { ReportsSchema } from '../packages/contract/src/index.ts'
import { extras, recordedReport } from './visual-fixtures-data.ts'

export const visualFixturesReports: Record<string, unknown> = {
  '/api/reports?range=7d': ReportsSchema.parse({ ...recordedReport, ...extras }),
  // Reports warms the other presets once the first one loads; the picture only needs them to exist.
  '/api/reports?range=today': ReportsSchema.parse({
    ...recordedReport,
    ...extras,
    range: 'today',
  }),
  '/api/reports?range=30d': ReportsSchema.parse({
    ...recordedReport,
    ...extras,
    range: '30d',
  }),
}
