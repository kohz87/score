import { expect, test } from 'vitest'
import {
  boldAddAgentLink,
  boldChatLink,
  boldCommandLink,
  boldFirstRunLink,
  boldJobLink,
  boldMessageLink,
  boldNoteLink,
  boldOneToOneLink,
  boldRecipesLink,
  boldSettingsSectionLink,
  boldStartJobLink,
  boldWorkbenchLink,
} from './bold-links.ts'

test('every bold-shell destination keeps its query parameters in one place', () => {
  expect(boldJobLink('job 1')).toBe('/b?job=job+1')
  expect(boldMessageLink('j1', 'm 1')).toBe('/b?job=j1&message=m+1')
  expect(boldChatLink('builder', 'c1')).toBe('/b?with=builder&chat=c1')
  expect(boldOneToOneLink('builder')).toBe('/b?with=builder')
  expect(boldNoteLink('Projects/Roadmap.md')).toBe('/b?note=Projects%2FRoadmap.md')
  expect(boldStartJobLink()).toBe('/b?start=job')
  expect(boldRecipesLink()).toBe('/b?recipes=1')
  expect(boldFirstRunLink()).toBe('/b?first=run')
  expect(boldCommandLink('assign')).toBe('/b?command=assign')
  expect(boldAddAgentLink()).toBe('/b/team?add=agent')
  expect(boldSettingsSectionLink('look')).toBe('/b/settings/look')
  expect(boldWorkbenchLink('?job=job+1&note=Projects%2FRoadmap.md')).toBe(
    '/b?job=job+1&note=Projects%2FRoadmap.md&work=workbench',
  )
})
