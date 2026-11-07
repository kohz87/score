import { expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import { cases } from './schemas-cases.ts'

test('every exported schema has valid and invalid fixtures', () => {
  const exported = Object.keys(contract).filter((name) => name.endsWith('Schema'))
  expect(cases.map(([name]) => name).sort()).toEqual(exported.sort())
})
