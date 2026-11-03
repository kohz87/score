import { expect, test } from 'vitest'
import { dockOverflow } from './BoldShell.tsx'

test('a big team shows seven rings with a +N overflow, and anyone who needs you stays in', () => {
  const team = Array.from({ length: 11 }, (_, index) => ({ id: `a${index}`, needs: index === 9 }))
  const { shown, hidden } = dockOverflow(team, (agent) => agent.needs)
  expect(shown).toHaveLength(6)
  expect(hidden).toBe(5)
  expect(shown.some((agent) => agent.id === 'a9')).toBe(true)
  expect(dockOverflow(team.slice(0, 7), () => false)).toEqual({
    shown: team.slice(0, 7),
    hidden: 0,
  })
})
