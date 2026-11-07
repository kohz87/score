import { screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { TodoCard } from './TodoCard.tsx'
import {
  agent,
  initialMemory,
  setUpAgentMoreTests,
  type Call,
  type Memory,
  type Override,
} from './agent-more-helpers.tsx'

let calls: Call[] = []
let override: Override | null = null
let memory: Memory[] = initialMemory()
const { mount } = setUpAgentMoreTests({
  calls: () => calls,
  override: () => override,
  memory: () => memory,
  setMemory: (next) => {
    memory = next
  },
  reset: () => {
    calls = []
    override = null
    memory = initialMemory()
  },
})

test('Todo lists the items with their state in words', async () => {
  mount(<TodoCard agent={agent} />)
  expect(await screen.findByText('Write tests')).toBeDefined()
  expect(screen.getByText('To do')).toBeDefined()
})
