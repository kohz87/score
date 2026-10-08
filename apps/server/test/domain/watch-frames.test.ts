import { describe, expect, test } from 'vitest'
import {
  framesForTool,
  isCredentialPath,
  isSensitiveTool,
  tailBytes,
  type ToolFrameInput,
} from '../../src/domain/watch-frames.ts'

const base: ToolFrameInput = {
  hook: 'post',
  tool: 'terminal',
  args: {},
  result: {},
  status: 'ok',
  watch: null,
  lastBrowser: null,
}
const frames = (input: Partial<ToolFrameInput>) => framesForTool({ ...base, ...input })

describe('terminal and code frames', () => {
  test('pre is running with no output; post carries output, cwd and status', () => {
    const args = { command: 'pnpm test', workdir: '/work' }
    expect(frames({ hook: 'pre', args, status: 'running' })).toMatchObject([
      { surface: 'terminal', payload: { command: 'pnpm test', output: '', status: 'running' } },
    ])
    expect(
      frames({ args, result: { output: '3 passed', exit_code: 0, cwd: '/work/sub' } }),
    ).toMatchObject([
      {
        payload: { cwd: '/work/sub', output: '3 passed', status: 'ok' },
        caption: 'Ran pnpm test',
      },
    ])
  })

  test.each([
    ['non-zero exit', { status: 'ok' as const, result: { output: '', exit_code: 2 } }],
    ['tool error', { status: 'error' as const, result: {} }],
    ['error field', { status: 'ok' as const, result: { error: 'boom' } }],
    ['plugin exit code', { status: 'ok' as const, watch: { exitCode: 1 } }],
  ])('%s is an error frame', (_, extra) => {
    expect(frames({ args: { command: 'x' }, ...extra })[0]?.payload).toMatchObject({
      status: 'error',
    })
  })

  test('the plugin tail wins, is marked and stays within 64 KB of UTF-8', () => {
    const [frame] = frames({
      args: { command: 'x' },
      watch: { output: '🙂'.repeat(40_000), tail: true },
      result: { output: 'ignored' },
    })
    const output = (frame!.payload as { output: string }).output
    expect(output.startsWith('[earlier output omitted]\n')).toBe(true)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024)
  })

  test('code runs get a script caption and the code as the command', () => {
    expect(
      frames({ tool: 'execute_code', args: { code: 'print(1)' }, result: { output: '1\n' } }),
    ).toMatchObject([{ payload: { command: 'print(1)', output: '1\n' }, caption: 'Ran a script' }])
  })

  test('malformed args and results degrade to an empty command, never throw', () => {
    expect(frames({ args: 5, result: 'text' })).toMatchObject([
      { payload: { command: '', output: '' }, caption: 'Ran a command' },
    ])
  })
})

describe('editor frames', () => {
  test('write_file and patch yield one frame per file, only after success', () => {
    const args = { path: 'src/a.ts', content: 'const a = 1\n' }
    expect(frames({ hook: 'pre', tool: 'write_file', args, status: 'running' })).toEqual([])
    expect(frames({ tool: 'write_file', args, status: 'error' })).toEqual([])
    const [frame] = frames({ tool: 'write_file', args, result: { success: true } })
    expect(frame).toMatchObject({
      surface: 'editor',
      payload: { path: 'src/a.ts', language: 'typescript' },
      caption: 'Wrote src/a.ts',
    })
    expect((frame!.payload as { diff: string }).diff).toContain('+const a = 1')
    const patched = frames({
      tool: 'patch',
      args: { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' },
      result: { success: true },
    })
    expect(patched).toHaveLength(1)
    expect(patched[0]!.caption).toBe('Edited src/a.ts')
  })

  test('credential files show the path but never the content', () => {
    const [frame] = frames({
      tool: 'write_file',
      args: { path: 'app/.env.local', content: 'API_TOKEN=abc\n' },
      result: { success: true },
    })
    expect(JSON.stringify(frame)).not.toContain('API_TOKEN')
    expect(frame!.payload).toMatchObject({ diff: '[contents hidden: credential file]' })
  })
})

describe('browser frames', () => {
  test('navigate opens a host; other tools reuse the last page', () => {
    expect(
      frames({
        tool: 'browser_navigate',
        args: { url: 'https://example.com/a' },
        result: { url: 'https://example.com/a', title: 'A' },
      }),
    ).toMatchObject([
      {
        payload: { url: 'https://example.com/a', title: 'A', imageUrl: null },
        caption: 'Opened example.com',
      },
    ])
    expect(
      frames({
        tool: 'browser_click',
        lastBrowser: { url: 'https://example.com/a', title: 'A' },
      }),
    ).toMatchObject([{ payload: { url: 'https://example.com/a' }, caption: 'Clicked on the page' }])
    expect(frames({ hook: 'pre', tool: 'browser_navigate' })).toEqual([])
  })

  test('vault tools never use their args or result, only a plain sentence', () => {
    const planted = { password: 'planted-vault-secret', site: 'bank.example' }
    for (const [tool, caption] of [
      ['browser_vault_fill', 'Filled a saved login'],
      ['browser_vault_unlock', 'Used the password vault'],
      ['browser_vault_list', 'Used the password vault'],
    ] as const) {
      const output = frames({
        tool,
        args: planted,
        result: planted,
        lastBrowser: { url: 'https://example.com/login', title: 'Login' },
      })
      expect(output).toHaveLength(1)
      expect(output[0]!.caption).toBe(caption)
      expect(JSON.stringify(output)).not.toMatch(/planted-vault-secret|bank\.example/)
    }
    expect(frames({ hook: 'pre', tool: 'browser_vault_fill', args: planted })).toEqual([])
  })

  test('other credential-bearing tools produce no frame', () => {
    expect(
      frames({ tool: 'secret_store_get', args: { name: 'x' }, result: { value: 'y' } }),
    ).toEqual([])
  })
})

test('helpers', () => {
  expect(
    ['browser_vault_fill', 'vault_x', 'get_password', 'api_key_tool'].every(isSensitiveTool),
  ).toBe(true)
  expect(['terminal', 'patch', 'browser_navigate', undefined].some(isSensitiveTool)).toBe(false)
  expect(['.env', 'a/.env.prod', 'k/id_rsa', 'x.pem', '.netrc'].every(isCredentialPath)).toBe(true)
  expect(['src/env.ts', 'docs/environment.md', 'src/keys.ts'].some(isCredentialPath)).toBe(false)
  expect(tailBytes('abc', 10)).toEqual({ text: 'abc', cut: false })
  expect(tailBytes('a🙂bc', 5)).toEqual({ text: 'bc', cut: true })
  expect(tailBytes('a🙂bc', 6)).toEqual({ text: '🙂bc', cut: true })
})
