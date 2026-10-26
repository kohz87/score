import type { Message } from '@score/contract'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ReplyGroup } from './ReplyGroup.tsx'
import { makeMessage } from './room-test-utils.tsx'
import { groupReplies, isFailedReply, swipeStep } from './reply-versions.ts'

const by = (id: string, extra: Partial<Message> = {}) =>
  makeMessage({
    id,
    author: { kind: 'agent', agentId: 'builder' },
    parts: [{ kind: 'text', text: `text ${id}` }],
    ...extra,
  })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('groupReplies', () => {
  test('versions fold into the first reply, in order, at its place', () => {
    const list = [
      makeMessage({ id: 'q' }),
      by('a'),
      by('x'),
      by('b', { alternativeOf: 'a' }),
      by('c', { alternativeOf: 'a' }),
    ]
    const groups = groupReplies(list)
    expect([...groups.byHead.keys()]).toEqual(['a'])
    expect(groups.byHead.get('a')!.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect([...groups.folded]).toEqual(['b', 'c'])
  })

  test('a version streaming in joins the group', () => {
    const groups = groupReplies([by('a'), by('b', { alternativeOf: 'a', streaming: true })])
    expect(groups.byHead.get('a')!.at(-1)!.streaming).toBe(true)
  })

  test('when the first reply was deleted the first remaining version holds the place', () => {
    const groups = groupReplies([by('b', { alternativeOf: 'a' }), by('c', { alternativeOf: 'a' })])
    expect(groups.byHead.get('b')!.map((m) => m.id)).toEqual(['b', 'c'])
    expect([...groups.folded]).toEqual(['c'])
  })

  test('a lone survivor is a plain message', () => {
    expect(groupReplies([by('b', { alternativeOf: 'a' })]).byHead.size).toBe(0)
  })
})

test('isFailedReply recognises the server’s failure notices only', () => {
  const text = (value: string) => by('f', { parts: [{ kind: 'text', text: value }] })
  expect(isFailedReply(text('This run failed: x'))).toBe(true)
  expect(isFailedReply(text('This run was stopped.'))).toBe(true)
  expect(isFailedReply(text('Couldn’t start this agent (x).'))).toBe(true)
  expect(isFailedReply(text('I ran out of steps for this turn (9 tool calls).'))).toBe(false)
  expect(
    isFailedReply(
      by('m', {
        parts: [
          { kind: 'text', text: 'Working on it' },
          { kind: 'tools', summary: 'ran 2 tools', runId: 'r1' },
          { kind: 'text', text: 'This run failed: boom' },
        ],
      }),
    ),
  ).toBe(true)
  expect(isFailedReply(text('All good.'))).toBe(false)
  expect(isFailedReply(by('s', { streaming: true }))).toBe(false)
})

test('swipeStep needs 48px and a mostly horizontal move', () => {
  expect(swipeStep(-60, 10)).toBe(1)
  expect(swipeStep(60, -10)).toBe(-1)
  expect(swipeStep(-40, 0)).toBe(0)
  expect(swipeStep(-60, 40)).toBe(0)
  expect(swipeStep(-60, 30)).toBe(0)
})

function renderGroup(group: Message[]) {
  return render(
    <ReplyGroup
      group={group}
      agentName="builder"
      render={(shown, parts) => (
        <div data-testid="shown">
          {shown.id}
          {parts.pager}
          {parts.note}
          <output data-testid="writing">{String(parts.writing)}</output>
        </div>
      )}
    />,
  )
}

const three = [by('a'), by('b', { alternativeOf: 'a' }), by('c', { alternativeOf: 'a' })]
const shownId = () => screen.getByTestId('shown').firstChild!.textContent

describe('ReplyGroup', () => {
  test('selects the newest, pages with the buttons and says where it is', () => {
    renderGroup(three)
    expect(shownId()).toBe('c')
    expect(screen.getByText('3 / 3')).toBeDefined()
    expect(screen.getByText('Version 3 of 3')).toBeDefined()
    expect(screen.getByText('builder remembers its earlier answers')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
    expect(shownId()).toBe('b')
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }))
    expect(shownId()).toBe('c')
  })

  test('arrow keys page too, and the ends do nothing', () => {
    renderGroup(three)
    const pager = screen.getByRole('group', { name: 'Versions of this reply' })
    fireEvent.keyDown(pager, { key: 'ArrowRight' })
    expect(shownId()).toBe('c')
    fireEvent.keyDown(pager, { key: 'ArrowLeft' })
    fireEvent.keyDown(pager, { key: 'ArrowLeft' })
    fireEvent.keyDown(pager, { key: 'ArrowLeft' })
    expect(shownId()).toBe('a')
  })

  test('a newer version arriving becomes selected', () => {
    const view = renderGroup(three)
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
    expect(shownId()).toBe('b')
    view.rerender(
      <ReplyGroup
        group={[...three, by('d', { alternativeOf: 'a', streaming: true })]}
        agentName="builder"
        render={(shown, parts) => (
          <div data-testid="shown">
            {shown.id}
            {parts.pager}
            <output data-testid="writing">{String(parts.writing)}</output>
          </div>
        )}
      />,
    )
    expect(shownId()).toBe('d')
    expect(screen.getByTestId('writing').textContent).toBe('true')
  })

  test('works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderGroup(three)
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
    expect(shownId()).toBe('b')
    vi.restoreAllMocks()
  })

  test('the pick is remembered per group', () => {
    const first = renderGroup(three)
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
    first.unmount()
    renderGroup(three)
    expect(shownId()).toBe('b')
  })

  test('a horizontal touch swipe changes the version, a vertical one does not, a selection blocks it', () => {
    renderGroup(three)
    const area = document.querySelector('.bold-reply-group')!
    const swipe = (dx: number, dy: number) => {
      fireEvent.touchStart(area, { touches: [{ clientX: 200, clientY: 100 }] })
      fireEvent.touchEnd(area, {
        changedTouches: [{ clientX: 200 + dx, clientY: 100 + dy }],
      })
    }
    swipe(80, 5)
    expect(shownId()).toBe('b')
    swipe(80, 60)
    expect(shownId()).toBe('b')
    // A selection elsewhere in the page does not block; one inside the bubble does.
    const outside = vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: document.body,
      focusNode: document.body,
    } as unknown as Selection)
    const inside = vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: area,
      focusNode: area,
    } as unknown as Selection)
    swipe(80, 0)
    expect(shownId()).toBe('b')
    inside.mockRestore()
    outside.mockRestore()
    swipe(-80, 0)
    expect(shownId()).toBe('c')
  })
})

describe('ReplyGroup, review round', () => {
  test('the pager keeps focus across two Next presses', () => {
    const six = [by('a'), by('b', { alternativeOf: 'a' }), by('c', { alternativeOf: 'a' })]
    window.localStorage.setItem('score.replyVersion.a', 'a')
    const view = render(
      <ReplyGroup
        group={six}
        agentName="builder"
        render={(shown, parts) => (
          <div key={shown.id} data-testid="shown">
            {shown.id}
            {parts.pager}
          </div>
        )}
      />,
    )
    expect(view.container.textContent).toContain('1 / 3')
    const next = screen.getByRole('button', { name: 'Next version' })
    next.focus()
    fireEvent.click(next)
    expect(screen.getByText('2 / 3')).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next version' }))
    fireEvent.click(document.activeElement!)
    expect(screen.getByText('3 / 3')).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next version' }))
  })

  test('a newer version clears the stored pick', () => {
    window.localStorage.setItem('score.replyVersion.a', 'a')
    const draw = (shown: Message) => <div data-testid="shown">{shown.id}</div>
    const view = render(<ReplyGroup group={three} agentName="builder" render={draw} />)
    expect(shownId()).toBe('a')
    view.rerender(
      <ReplyGroup
        group={[...three, by('d', { alternativeOf: 'a' })]}
        agentName="builder"
        render={draw}
      />,
    )
    expect(shownId()).toBe('d')
    expect(window.localStorage.getItem('score.replyVersion.a')).toBeNull()
  })

  test('touches that start in code, tables, links or controls are not swipes', () => {
    render(
      <ReplyGroup
        group={three}
        agentName="builder"
        render={(shown, parts) => (
          <div data-testid="shown">
            {shown.id}
            <pre id="code">x</pre>
            <a id="link" href="#x">
              l
            </a>
            <p id="plain">text</p>
            {parts.pager}
          </div>
        )}
      />,
    )
    const swipeOn = (target: Element) => {
      fireEvent.touchStart(target, { touches: [{ clientX: 200, clientY: 100 }] })
      fireEvent.touchEnd(target, { changedTouches: [{ clientX: 300, clientY: 100 }] })
    }
    swipeOn(document.getElementById('code')!)
    swipeOn(document.getElementById('link')!)
    swipeOn(screen.getByRole('button', { name: 'Previous version' }))
    expect(shownId()).toBe('c')
    swipeOn(document.getElementById('plain')!)
    expect(shownId()).toBe('b')
  })
})
