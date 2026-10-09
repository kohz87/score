import { expect, test } from 'vitest'
import type { Reports } from '@score/contract'
import { csvCell, reportCsvColumns, reportsToCsv } from '../../src/domain/reports-csv.ts'

const base: Reports = {
  range: '7d',
  summary: '',
  totals: {
    tasksFinished: 0,
    runs: 0,
    firstPassRate: null,
    medianTaskSec: null,
    spendUsd: null,
    cacheHitRate: null,
  },
  byDay: [],
  timeSplit: [],
  byAgent: [],
  trend: [],
  approvals: { asked: 0, approved: 0, denied: 0, medianWaitSec: null, insight: null },
}

test('csvCell quotes per RFC 4180', () => {
  expect(csvCell('plain')).toBe('plain')
  expect(csvCell('a,b')).toBe('"a,b"')
  expect(csvCell('say "hi"')).toBe('"say ""hi"""')
  expect(csvCell('two\nlines')).toBe('"two\nlines"')
  expect(csvCell(null)).toBe('')
  expect(csvCell(12)).toBe('12')
})

test('csvCell neutralises spreadsheet formulas', () => {
  for (const text of ['=SUM(A1)', '+1', '-2', '@cmd', '\tx']) {
    expect(csvCell(text)).toBe(`'${text}`)
  }
  expect(csvCell('=1,2')).toBe('"\'=1,2"')
})

test('reportsToCsv matches the By agent table columns', () => {
  const csv = reportsToCsv(
    {
      ...base,
      byAgent: [
        {
          agentId: 'builder',
          finished: 3,
          runs: 7,
          medianSec: 1860,
          firstPassRate: 0.65,
          spendUsd: 2.4,
          cacheHitRate: null,
        },
        {
          agentId: 'reviewer',
          finished: 0,
          runs: 1,
          medianSec: null,
          firstPassRate: null,
          spendUsd: null,
          cacheHitRate: null,
        },
        {
          agentId: 'x',
          finished: 1,
          runs: 1,
          medianSec: 60,
          firstPassRate: 1,
          spendUsd: 0,
          cacheHitRate: null,
        },
      ],
    },
    { builder: 'Builder, Inc', reviewer: 'Reviewer', x: '=HYPERLINK("x")' },
  )
  expect(csv.split('\r\n')).toEqual([
    reportCsvColumns.join(','),
    '"Builder, Inc",3,7,31,65,2.40',
    'Reviewer,0,1,,n/a,',
    '"\'=HYPERLINK(""x"")",1,1,1,100,0.00',
    '',
  ])
})
