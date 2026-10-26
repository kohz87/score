import { expect, test } from 'vitest'
import {
  boldAddAgentLink,
  boldAgentScreenLink,
  boldAgentWorkspaceLink,
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
  boldResultsLink,
  boldWorkspaceLink,
  boldWorkbenchLink,
  workbenchHref,
} from './bold-links.ts'

test('every bold-shell destination keeps its query parameters in one place', () => {
  expect(boldJobLink('job 1')).toBe('/b?job=job+1')
  expect(boldMessageLink('j1', 'm 1')).toBe('/b?job=j1&message=m+1')
  expect(boldChatLink('builder', 'c1')).toBe('/b?with=builder&chat=c1')
  expect(boldOneToOneLink('builder')).toBe('/b?with=builder')
  expect(boldOneToOneLink('builder', '?job=job+1&note=Projects%2FRoadmap.md')).toBe(
    '/b?job=job+1&note=Projects%2FRoadmap.md&with=builder',
  )
  expect(boldOneToOneLink('builder', '?job=job+1&file=api%2Fevents.py')).toBe(
    '/b?job=job+1&file=api%2Fevents.py&with=builder',
  )
  expect(boldNoteLink('Projects/Roadmap.md')).toBe('/b?note=Projects%2FRoadmap.md')
  expect(boldStartJobLink()).toBe('/b?start=job')
  expect(boldStartJobLink('wf 1')).toBe('/b?start=job&recipe=wf+1')
  expect(boldRecipesLink()).toBe('/b/recipes')
  expect(boldRecipesLink('wf 1')).toBe('/b/recipes/wf%201')
  expect(boldFirstRunLink()).toBe('/b?first=run')
  expect(boldCommandLink('assign')).toBe('/b?command=assign')
  expect(boldAddAgentLink()).toBe('/b/team?add=agent')
  expect(boldSettingsSectionLink('look')).toBe('/b/settings/look')
  expect(boldWorkbenchLink('?job=job+1&note=Projects%2FRoadmap.md')).toBe(
    '/b?job=job+1&note=Projects%2FRoadmap.md&work=workbench',
  )
  expect(boldWorkbenchLink('?job=job+1&work=code&file=api%2Fevents.py')).toBe(
    '/b?job=job+1&work=workbench',
  )
  expect(boldResultsLink('?job=job+1&work=code&file=api%2Fevents.py')).toBe('/b?job=job+1')
  expect(boldResultsLink('?work=screen')).toBe('/b')
  expect(workbenchHref('job 1', 'code', 'api/events.py')).toBe(
    '/b?job=job+1&work=code&file=api%2Fevents.py',
  )
  expect(boldAgentScreenLink('builder')).toBe('/b/screen/builder')
  expect(boldAgentWorkspaceLink('builder', 'api/events.py')).toBe(
    '/b/team/builder?path=api%2Fevents.py#agent-workspace',
  )
})

test('workspace:// links use the job Workbench for a changed file and the agent Workspace otherwise', () => {
  const job = { id: 'job-feed', files: ['api/events.py', './docs/release-notes.md'] }
  expect(boldWorkspaceLink('builder', 'api/events.py', job)).toBe(
    '/b?job=job-feed&work=code&file=api%2Fevents.py',
  )
  expect(boldWorkspaceLink('builder', './docs/release-notes.md', job)).toBe(
    '/b?job=job-feed&work=code&file=.%2Fdocs%2Frelease-notes.md',
  )
  expect(boldWorkspaceLink('reviewer', 'notes/other.md', job)).toBe(
    '/b/team/reviewer?path=notes%2Fother.md#agent-workspace',
  )
})
