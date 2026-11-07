import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  boldButton,
  renderStream,
  setupRoomMessageStreamTest,
  stubStream,
} from './RoomMessageStream-helpers.tsx'

setupRoomMessageStreamTest()

test('the chat reads as one conversation: every topic’s messages are on show together', async () => {
  stubStream()
  renderStream()
  await screen.findByText('Read layer is ready.')
  expect(screen.getByText('Add ws.')).toBeDefined()
  expect(screen.getByText('Drafted the 2.4 notes.')).toBeDefined()
})

test('the hover row pins and unpins through the contract, and keeps the state pressed', async () => {
  const fetchMock = stubStream()
  renderStream()
  await screen.findByText('Read layer is ready.')

  const unpin = await waitFor(() => boldButton('Unpin message from builder'))
  expect(unpin.getAttribute('aria-pressed')).toBe('true')
  const pin = boldButton('Pin message from You')
  fireEvent.click(pin)
  await waitFor(() => boldButton('Unpin message from You'))
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url) === '/api/rooms/room-1/pins/message-2' && init?.method === 'POST',
    ),
  ).toBe(true)

  fireEvent.click(boldButton('Unpin message from You'))
  await waitFor(() => boldButton('Pin message from You'))
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url) === '/api/rooms/room-1/pins/message-2' && init?.method === 'DELETE',
    ),
  ).toBe(true)
})

test('copy puts the message text on the clipboard and confirms it', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  stubStream()
  renderStream()
  await screen.findByText('Read layer is ready.')
  fireEvent.click(boldButton('Copy message from builder'))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Read layer is ready.'))
  expect(boldButton('Copy message from builder').textContent).toBe('Copied')
})

test('an agent reply offers Save to Library and opens the Library save dialog', async () => {
  stubStream()
  renderStream()
  await screen.findByText('Read layer is ready.')
  fireEvent.click(boldButton('Save message from builder to Library'))
  expect(await screen.findByRole('dialog', { name: 'Save to Knowledge' })).toBeDefined()
  expect(screen.getByText('This reply as a note')).toBeDefined()
})

test('your own message offers edit and delete; the delete asks for a rewind', async () => {
  stubStream()
  renderStream()
  await screen.findByText('Add ws.')
  expect(boldButton('Edit message from You')).toBeDefined()
  fireEvent.click(boldButton('Delete message from You'))
  expect(await screen.findByRole('dialog', { name: 'Delete this message?' })).toBeDefined()
})
