import { expect, test } from 'vitest'
import { MCP_TOKEN_PATTERN, McpAccessPatchSchema, MessagePartSchema } from '../src/index.ts'

test('MCP tokens are distinct from 43-character bridge tokens', () => {
  expect(MCP_TOKEN_PATTERN.test(`scm_${'a'.repeat(43)}`)).toBe(true)
  expect(MCP_TOKEN_PATTERN.test('a'.repeat(43))).toBe(false)
  expect(MCP_TOKEN_PATTERN.test(`scm_${'a'.repeat(42)}`)).toBe(false)
})

test('the access patch needs a change and refuses unknown fields', () => {
  expect(McpAccessPatchSchema.safeParse({}).success).toBe(false)
  expect(McpAccessPatchSchema.safeParse({ enabled: true, agentId: 'x' }).success).toBe(false)
  expect(McpAccessPatchSchema.safeParse({ writesEnabled: false }).success).toBe(true)
})

test('a text part may carry via: mcp, nothing else', () => {
  expect(MessagePartSchema.safeParse({ kind: 'text', text: 'x', via: 'mcp' }).success).toBe(true)
  expect(MessagePartSchema.safeParse({ kind: 'text', text: 'x', via: 'other' }).success).toBe(false)
})
