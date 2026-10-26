import { describe, expect, it } from 'vitest'
import { previewAgentId, previewPages } from './preview-pages.ts'

describe('the preview pages of the new look (PLAN 11.9d)', () => {
  it('offers Room, Team, an agent page, the agent screen and Settings of the new shell', () => {
    expect(previewPages.map((page) => page.path)).toEqual([
      '/b',
      '/b/team',
      '/b/team/lead',
      '/b/screen/lead',
      '/b/settings',
    ])
  })

  it('opens the agent page of the first agent of the team, and leaves the other pages alone', () => {
    const agent = previewPages.find((page) => page.id === 'b-agent')!
    expect(previewAgentId(agent, 'builder').path).toBe('/b/team/builder')
    expect(previewAgentId(agent, null).path).toBe('/b/team/lead')
    const screen = previewPages.find((page) => page.id === 'b-screen')!
    expect(previewAgentId(screen, 'builder').path).toBe('/b/screen/builder')
    const team = previewPages.find((page) => page.id === 'b-team')!
    expect(previewAgentId(team, 'builder')).toBe(team)
  })
})
