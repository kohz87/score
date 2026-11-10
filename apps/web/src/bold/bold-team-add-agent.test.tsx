import { PROFILE_IMPORT_MAX_BYTES } from '@score/contract'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { builder } from './bold-team-fixtures.ts'
import { open, teamState } from './bold-team-helpers.tsx'

test('?add=agent opens the Add an agent dialog with the nine offered shapes and taken colours disabled', async () => {
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })

  const shapes = within(dialog).getByRole('radiogroup', { name: 'Shape' })
  expect(within(shapes).getAllByRole('radio')).toHaveLength(9)
  fireEvent.click(within(shapes).getByRole('radio', { name: 'ball' }))
  expect(within(dialog).getByRole('img', { name: 'New agent, ball' })).toBeDefined()

  const colours = within(dialog).getByRole('radiogroup', { name: 'Colour' })
  const taken = within(colours).getByRole('radio', {
    name: 'Colour #19c39a, used by builder',
  }) as HTMLInputElement
  expect(taken.disabled).toBe(true)
  const free = within(colours).getByRole('radio', { name: 'Colour #2bb3c0' }) as HTMLInputElement
  fireEvent.click(free)
  expect(free.checked).toBe(true)
})

test('a full palette starts a new agent on an enabled generated colour', async () => {
  const palette = ['#6b8cff', '#2bb3c0', '#ff8a3d', '#8bd450']
  teamState.agentsReply = () =>
    Response.json({
      asOfSeq: 1,
      items: palette.map((color, index) => ({
        ...builder,
        id: `agent-${index}`,
        name: `agent-${index}`,
        reportsTo: null,
        style: { color, shape: 'hexagon' },
      })),
    })
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  const colours = within(dialog).getByRole('radiogroup', { name: 'Colour' })
  const radios = within(colours).getAllByRole('radio') as HTMLInputElement[]
  const selected = await waitFor(() => {
    const choice = (within(colours).getAllByRole('radio') as HTMLInputElement[]).find(
      (radio) => radio.checked,
    )
    expect(choice?.disabled).toBe(false)
    return choice
  })
  expect(selected).toBeDefined()
  expect(radios.filter((radio) => !radio.disabled).length).toBeGreaterThan(0)
  expect(radios.length).toBeGreaterThan(palette.length)
})

test('the bold dialog reuses the classic preview hash and inheritance confirmation when copying', async () => {
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'researcher' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Finds and compares options.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  fireEvent.change(within(dialog).getByLabelText('Copy from'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))

  expect(await within(dialog).findByRole('heading', { name: 'Review changes' })).toBeDefined()
  expect(within(dialog).getByText('Create profile researcher')).toBeDefined()
  expect(within(dialog).getByText('Release notes go through reviewer first.')).toBeDefined()
  expect(
    within(dialog).getByRole('button', { name: 'Add researcher' }).hasAttribute('disabled'),
  ).toBe(true)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /what this agent inherits/ }))
  expect(
    within(dialog).getByRole('button', { name: 'Add researcher' }).hasAttribute('disabled'),
  ).toBe(false)
})

test('the coding tool shows install state and checks the CLI version again', async () => {
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.click(within(dialog).getByRole('radio', { name: /A coding tool/ }))
  expect(await within(dialog).findByText(/Installed · version 2\.1\.295/)).toBeDefined()
  expect(within(dialog).queryByLabelText('Works on')).toBeNull()
  expect(within(dialog).getByText('Runs on this machine as you.')).toBeDefined()
  expect(
    (within(dialog).getByRole('radio', { name: 'Claude Code' }) as HTMLInputElement).type,
  ).toBe('radio')

  const initialCalls = teamState.runtimeCalls
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check version again' }))
  await waitFor(() => expect(teamState.runtimeCalls).toBeGreaterThan(initialCalls))

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Antigravity (agy)' }))
  expect(
    await within(dialog).findByText(/Antigravity \(agy\) is not installed/, { exact: false }),
  ).toBeDefined()

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Codex' }))
  expect(await within(dialog).findByRole('checkbox', { name: /can read any file/ })).toBeDefined()
})

test('the import size hint follows the contract maximum', async () => {
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.click(within(dialog).getByRole('radio', { name: /Bring in a Hermes profile/ }))
  const megabytes = Math.round(PROFILE_IMPORT_MAX_BYTES / (1024 * 1024))
  expect(within(dialog).getByText(`Profile export (.tar.gz, up to ${megabytes} MB)`)).toBeDefined()
})

test('while setup is running Escape and the backdrop leave the dialog open and the X asks first', async () => {
  let releasePreview: () => void = () => {}
  teamState.previewHold = new Promise<void>((resolve) => {
    releasePreview = resolve
  })
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'busy-agent' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Waits for the preview.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))
  await within(dialog).findByRole('button', { name: 'Loading preview…' })

  const cancel = new Event('cancel', { bubbles: true, cancelable: true })
  fireEvent(dialog, cancel)
  expect(cancel.defaultPrevented).toBe(true)
  expect(screen.getByRole('dialog', { name: 'Add an agent' })).toBe(dialog)

  fireEvent.click(dialog)
  expect(screen.getByRole('dialog', { name: 'Add an agent' })).toBe(dialog)

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  const confirm = within(dialog).getByRole('alertdialog', {
    name: 'Close while it’s still running?',
  })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(confirm).getByRole('button', { name: 'Keep waiting' }))

  teamState.previewHold = null
  releasePreview()
  expect(await within(dialog).findByRole('heading', { name: 'Review changes' })).toBeDefined()
})

test('a non-local Works on choice is saved after setup and a 409 reason is shown with retry', async () => {
  teamState.runsOnReply = () =>
    Response.json(
      {
        error: {
          code: 'backend_unavailable',
          message: 'Docker isn’t installed or its daemon is not running.',
        },
      },
      { status: 409 },
    )
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'runs-agent' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Runs checks in a box.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  expect(within(dialog).getByRole('option', { name: 'Docker (partly separated)' })).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText('Works on'), { target: { value: 'docker' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))
  await within(dialog).findByRole('heading', { name: 'Review changes' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add runs-agent' }))

  expect(
    await within(dialog).findByText('Docker isn’t installed or its daemon is not running.'),
  ).toBeDefined()
  const calls = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith('/api/agents/runs-agent/runs-on') && init?.method === 'PUT',
      )
  await waitFor(() => expect(calls()).toHaveLength(1))
  expect(JSON.parse(String(calls()[0]?.[1]?.body))).toEqual({ backend: 'docker' })

  teamState.runsOnReply = null
  fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
  expect(
    await within(dialog).findByRole('heading', { name: 'runs-agent joined the team' }),
  ).toBeDefined()
  expect(calls()).toHaveLength(2)
  expect(within(dialog).getByText(/Docker · Partly separated/)).toBeDefined()
  expect(within(dialog).getByText(/Commands run as root inside the container\./)).toBeDefined()
  expect(within(dialog).getByRole('link', { name: 'Where it works' }).getAttribute('href')).toBe(
    '/b/agents/runs-agent#agent-where',
  )
})

test('continuing past a failed Works on write says the agent runs on this machine, with the reason', async () => {
  teamState.runsOnReply = () =>
    Response.json(
      {
        error: {
          code: 'backend_unavailable',
          message: 'Docker isn’t installed or its daemon is not running.',
        },
      },
      { status: 409 },
    )
  open('/b/agents?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'runs-agent' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Runs checks in a box.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  fireEvent.change(within(dialog).getByLabelText('Works on'), { target: { value: 'docker' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))
  await within(dialog).findByRole('heading', { name: 'Review changes' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add runs-agent' }))

  expect(
    await within(dialog).findByText('Docker isn’t installed or its daemon is not running.'),
  ).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue on this machine' }))
  expect(
    await within(dialog).findByText(
      'Runs on this machine as you: Docker isn’t installed or its daemon is not running.',
    ),
  ).toBeDefined()
  expect(within(dialog).getByRole('link', { name: 'Where it works' }).getAttribute('href')).toBe(
    '/b/agents/runs-agent#agent-where',
  )
})
