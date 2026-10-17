import { expect, test } from 'vitest'
import { claudeDriver } from '../../src/runtimes/coding/claude.ts'
import { codexDriver } from '../../src/runtimes/coding/codex.ts'
import { antigravityDriver } from '../../src/runtimes/coding/antigravity.ts'
import {
  blockHash,
  frameOf,
  instructionsEtag,
  promptWithInstructions,
} from '../../src/runtimes/coding/instructions.ts'

// PLAN 8.8 (decision 94): the pure parts of handing a coding agent's role and instructions to its CLI.
const persona = { name: 'Builder', role: 'Writes code', instructions: 'Be brief.' }
const base = {
  workspace: '/work',
  prompt: 'hi',
  permission: 'read-only' as const,
  model: null,
  sessionId: null,
  settingsPath: null,
  denyPaths: [],
  denyFiles: [],
}

test('the frame names the agent, the role and the owner’s words, and keeps Score’s rules in force', () => {
  const frame = frameOf(persona)
  expect(frame).toContain('Your name in this team: Builder.')
  expect(frame).toContain('Your role: Writes code')
  expect(frame).toContain('The owner’s instructions for you:\n\nBe brief.')
  expect(frame).toMatch(/Score’s rules still apply/)
  expect(frameOf({ ...persona, instructions: '' })).not.toContain('The owner’s instructions')
  expect(frameOf({ ...persona, role: '  ' })).not.toContain('Your role')
})

test('no role and no instructions means no frame and no hash', () => {
  expect(frameOf({ name: 'Builder', role: '', instructions: '  \n' })).toBe('')
  expect(blockHash('')).toBe('')
  expect(blockHash(frameOf(persona))).toMatch(/^[0-9a-f]{32}$/)
  expect(blockHash(frameOf(persona))).not.toBe(blockHash(frameOf({ ...persona, role: 'Other' })))
})

test('the etag follows the text', () => {
  expect(instructionsEtag('a')).toBe(instructionsEtag('a'))
  expect(instructionsEtag('a')).not.toBe(instructionsEtag('b'))
  expect(instructionsEtag('')).toMatch(/^[0-9a-f]{16}$/)
})

test('prepending: a new session always gets the block, a resumed one only after a change', () => {
  const frame = frameOf(persona)
  const hash = blockHash(frame)
  const message = 'do it'
  expect(promptWithInstructions({ frame, sent: '', resumed: false, message })).toBe(
    `${frame}\n\n---\n\n${message}`,
  )
  expect(promptWithInstructions({ frame: '', sent: '', resumed: false, message })).toBe(message)
  expect(promptWithInstructions({ frame, sent: hash, resumed: true, message })).toBe(message)
  expect(promptWithInstructions({ frame: '', sent: '', resumed: true, message })).toBe(message)
  expect(promptWithInstructions({ frame, sent: '', resumed: true, message })).toMatch(
    /^Your instructions were updated:\n\nYour name in this team: Builder\./,
  )
  expect(promptWithInstructions({ frame: '', sent: hash, resumed: true, message })).toMatch(
    /^Your instructions were updated: the owner removed your role and instructions/,
  )
})

test('Claude Code: the file flag only when there is a file; a refresh only when asked; never the text', () => {
  const plain = claudeDriver.buildArgs(base)
  expect(plain.join(' ')).not.toMatch(/system-prompt/)
  const withFile = claudeDriver.buildArgs({ ...base, instructionsFile: '/home/x/coding/a/i.md' })
  expect(withFile).toEqual([...plain, '--append-system-prompt-file', '/home/x/coding/a/i.md'])
  const resumed = claudeDriver.buildArgs({
    ...base,
    sessionId: 's1',
    instructionsFile: '/f.md',
    refreshSystemPrompt: true,
  })
  expect(resumed).toEqual(
    expect.arrayContaining(['--resume', 's1', '--append-system-prompt-file', '/f.md']),
  )
  expect(resumed.slice(-2)).toEqual(['--system-prompt-snapshot', 'off'])
  // Cleared: the refresh stays so the recorded prompt is dropped, without a file.
  expect(
    claudeDriver.buildArgs({ ...base, sessionId: 's1', refreshSystemPrompt: true }),
  ).not.toContain('--append-system-prompt-file')
  expect(claudeDriver.instructions).toBe('file')
})

test('Codex and Antigravity have no instructions flag: their argv ignores the options', () => {
  expect(codexDriver.instructions).toBeUndefined()
  expect(antigravityDriver.instructions).toBeUndefined()
  expect(codexDriver.buildArgs({ ...base, instructionsFile: '/f.md' })).toEqual(
    codexDriver.buildArgs(base),
  )
  expect(antigravityDriver.buildArgs({ ...base, instructionsFile: '/f.md' })).toEqual(
    antigravityDriver.buildArgs(base),
  )
})
