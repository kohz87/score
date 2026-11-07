import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { runSummary, workflowPreflight } from '../../../../../e2e/workflow-fixtures.ts'
import { StartWorkflowDialog } from './StartWorkflowDialog.tsx'
import { agents, json, setUpWorkflowTests } from './workflows-test-helpers.tsx'

const { state, mount } = setUpWorkflowTests()

test('the start dialog needs the inputs, shows the exact incarnations and posts them with the acknowledgement', async () => {
  state.post = (url) =>
    url === '/api/workflow-runs'
      ? json({ run: runSummary, preflight: workflowPreflight }, 201)
      : undefined
  const created = vi.fn()
  mount(
    <StartWorkflowDialog
      workflowId="wf-release"
      agents={agents as never}
      close={() => {}}
      created={created}
    />,
  )
  const dialog = await screen.findByRole('dialog', { name: /Start Release notes/ })
  await within(dialog).findByRole('list', { name: 'Agent mapping' })
  expect(within(dialog).getByText('4f7c1d2e-8a3b-4c5d-9e6f-0a1b2c3d4e5f')).toBeTruthy()
  expect(within(dialog).getByText(/Only the gates you drew stop for you/)).toBeTruthy()
  const submit = within(dialog).getByRole('button', { name: 'Start the run' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  fireEvent.click(
    within(dialog).getByRole('checkbox', { name: /Score controls the work it starts/ }),
  )
  expect(submit.disabled).toBe(true) // the required input is still empty
  fireEvent.change(within(dialog).getByLabelText(/^Topic/), {
    target: { value: 'the 2.4 release' },
  })
  await waitFor(() => expect(submit.disabled).toBe(false))
  fireEvent.click(within(dialog).getByRole('radio', { name: /every agent step/ }))
  fireEvent.click(within(dialog).getByRole('radio', { name: /Keep going/ }))
  fireEvent.click(submit)
  await waitFor(() => expect(created).toHaveBeenCalled())
  const body = JSON.parse(
    String(
      state.requests.find((r) => r.url === '/api/workflow-runs' && r.init?.method === 'POST')!.init
        ?.body,
    ),
  )
  expect(body).toMatchObject({
    workflowId: 'wf-release',
    version: 1,
    inputs: { topic: 'the 2.4 release' },
    gatePolicy: 'every-step',
    unknownSpend: 'continue',
    agentMap: [
      { agentId: 'builder', incarnation: '4f7c1d2e-8a3b-4c5d-9e6f-0a1b2c3d4e5f' },
      { agentId: 'reviewer', incarnation: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
    ],
  })
  expect(body.acknowledgement.text).toMatch(/Score controls the work it starts/)
})
