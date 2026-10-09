import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NotificationsSection } from './NotificationsSection.tsx'
import { readNotificationPrefs } from '../../notifications/prefs.ts'

class FakeNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static shown: { title: string }[] = []
  onclick: (() => void) | null = null
  constructor(readonly title: string) {
    FakeNotification.shown.push({ title })
  }
  close() {}
}

beforeEach(() => {
  localStorage.clear()
  FakeNotification.permission = 'default'
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', FakeNotification)
  Object.assign(window, { Notification: FakeNotification })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('permission is asked only on the click, then the kinds can be chosen', async () => {
  render(<NotificationsSection />)
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  const kind = screen.getByRole('checkbox', { name: /A routine finished/ }) as HTMLInputElement
  expect(kind.closest('fieldset')!.disabled).toBe(true)
  FakeNotification.permission = 'granted'
  fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications on this device' }))
  await screen.findByRole('button', { name: 'Turn off notifications on this device' })
  expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  expect(readNotificationPrefs().enabled).toBe(true)
  fireEvent.click(kind)
  expect(readNotificationPrefs().kinds.routines).toBe(false)
  expect(readNotificationPrefs().kinds.approvals).toBe(true)
  const previews = screen.getByRole('checkbox', {
    name: /Show message previews/,
  }) as HTMLInputElement
  expect(previews.checked).toBe(false)
  fireEvent.click(previews)
  expect(readNotificationPrefs().previews).toBe(true)
})

test('a blocked permission explains how to allow it and leaves notifications off', async () => {
  FakeNotification.permission = 'denied'
  render(<NotificationsSection />)
  fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications on this device' }))
  await screen.findByText(/blocked notifications for Score/)
  expect(readNotificationPrefs().enabled).toBe(false)
})

test('a browser without notifications says so, with the iPhone hint', () => {
  delete (window as { Notification?: unknown }).Notification
  render(<NotificationsSection />)
  expect(screen.getByText(/Add to Home Screen/)).toBeDefined()
  expect(screen.queryByRole('button', { name: /Turn on/ })).toBeNull()
})

test('the test button shows a notification', async () => {
  FakeNotification.permission = 'granted'
  localStorage.setItem('score.notifications', JSON.stringify({ enabled: true }))
  render(<NotificationsSection />)
  fireEvent.click(screen.getByRole('button', { name: 'Send a test notification' }))
  await waitFor(() =>
    expect(FakeNotification.shown).toEqual([{ title: 'Score notifications work' }]),
  )
})
