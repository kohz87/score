import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoldFrameContext,
  type FrameRoom,
  boldRedirectFor,
  Link,
  toBoldPath,
} from './framed-paths.tsx'

describe('toBoldPath', () => {
  it('moves the kept classic pages under /b and keeps query and hash', () => {
    expect(toBoldPath('/workflows')).toBe('/b/recipes')
    expect(toBoldPath('/workflows/wf-1?x=1#a')).toBe('/b/recipes/wf-1?x=1#a')
    expect(toBoldPath('/watch/lead?from=4')).toBe('/b/screen/lead?from=4')
    expect(toBoldPath('/settings/look')).toBe('/b/settings/look')
    expect(toBoldPath('/settings/look/customize/t1')).toBe('/b/settings/look/customize/t1')
  })
  it('opens a run in the room’s Runs panel, keeping its query', () => {
    expect(toBoldPath('/runs/brief-1')).toBe('/b?run=brief-1')
    expect(toBoldPath('/runs/brief%201?x=1#a')).toBe('/b?x=1&run=brief+1#a')
  })
  it('keeps the #hash of a run link and survives a malformed escape', () => {
    expect(toBoldPath('/runs/brief-1?x=1#step')).toBe('/b?x=1&run=brief-1#step')
    expect(toBoldPath('/runs/%E0%A4%A')).toBe('/runs/%E0%A4%A')
  })
  it('sends team pages and chat rooms to their new homes', () => {
    expect(toBoldPath('/team/lead')).toBe('/b/team/lead')
    expect(toBoldPath('/team/lead/workspace?path=a')).toBe('/b/team/lead')
    expect(toBoldPath('/chat')).toBe('/b')
    // Without the room list a room opens by id; the room page falls back to the team room for an unknown one.
    expect(toBoldPath('/chat/room-1')).toBe('/b?room=room-1')
  })
  it('keeps the room a chat link meant', () => {
    const rooms: FrameRoom[] = [
      { id: 'team', kind: 'room', role: 'team', leadAgentId: null, members: [] },
      { id: 'dm-1', kind: 'direct', role: 'direct', leadAgentId: 'builder', members: ['builder'] },
      { id: 'old 1', kind: 'room', role: 'room', leadAgentId: 'lead', members: ['lead'] },
    ]
    expect(toBoldPath('/chat/team', rooms)).toBe('/b')
    expect(toBoldPath('/chat/dm-1', rooms)).toBe('/b?with=builder')
    expect(toBoldPath('/chat/old%201', rooms)).toBe('/b?room=old%201')
    expect(toBoldPath('/chat/gone', rooms)).toBe('/b?room=gone')
  })
  it('leaves /b paths and pages without a /b home alone', () => {
    expect(toBoldPath('/b/recipes')).toBe('/b/recipes')
    expect(toBoldPath('/terminal')).toBe('/terminal')
    expect(toBoldPath('/knowledge/a')).toBe('/knowledge/a')
    expect(toBoldPath('/workflowsx')).toBe('/workflowsx')
  })
})

describe('boldRedirectFor', () => {
  it('redirects only the kept classic pages, keeping the query', () => {
    expect(boldRedirectFor('/workflows', '?a=1')).toBe('/b/recipes?a=1')
    expect(boldRedirectFor('/workflows/new', '')).toBe('/b/recipes/new')
    expect(boldRedirectFor('/runs/b1', '?x=y', '#z')).toBeNull()
    expect(boldRedirectFor('/watch/lead', '?from=3')).toBe('/b/screen/lead?from=3')
    expect(boldRedirectFor('/settings/look/customize/t', '')).toBe('/b/settings/look/customize/t')
    expect(boldRedirectFor('/terminal', '')).toBe('/b/terminal')
    expect(boldRedirectFor('/settings/look', '')).toBeNull()
    expect(boldRedirectFor('/team', '')).toBeNull()
  })
})

function linkHref(framed: boolean): string {
  const router = createMemoryRouter([
    {
      path: '/',
      element: framed ? (
        <BoldFrameContext value={{ look: 'dark' }}>
          <Link to="/runs/b1">run</Link>
        </BoldFrameContext>
      ) : (
        <Link to="/runs/b1">run</Link>
      ),
    },
  ])
  render(<RouterProvider router={router} />)
  return screen.getByRole('link', { name: 'run' }).getAttribute('href') ?? ''
}

describe('Link', () => {
  afterEach(cleanup)
  it('maps inside the bold frame and not outside it', () => {
    expect(linkHref(true)).toBe('/b?run=b1')
  })
  it('keeps the classic path in the classic shell', () => {
    expect(linkHref(false)).toBe('/runs/b1')
  })
})
