#!/usr/bin/env node
// Stand-in for the coding CLIs in tests and fake mode (selected by SCORE_CODING_FAKE_CLI, honoured only in fake mode
// and under test). It never talks to a model: it prints a hand-made fixture selected by `[fixture:NAME]` in the prompt.
// `[fixture:subagent]` (claude-code) prints a recorded turn that used a sub-agent (PLAN 8.7).
// Usage: node fake-cli.mjs <claude-code|codex|antigravity> <the real CLI's arguments…>
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [runtime, ...args] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const fixtureNames = { 'claude-code': 'claude', codex: 'codex', antigravity: 'antigravity' }

if (args.includes('--version')) {
  const version = process.env.SCORE_CODING_FAKE_VERSION
  if (runtime === 'claude-code') console.log(`${version ?? '2.1.295'} (Claude Code)`)
  else if (runtime === 'codex') console.log(`codex-cli ${version ?? '0.160.1'}`)
  else if (runtime === 'antigravity') console.log(`${version ?? '1.3.3'}`)
  else process.exit(127)
  process.exit(0)
}

// 3.7.7: the help text the version check reads (an excerpt of the real one), or SCORE_CODING_FAKE_HELP's file instead.
if (args.includes('--help')) {
  const file = process.env.SCORE_CODING_FAKE_HELP ?? join(here, 'help', `${runtime}.txt`)
  if (!existsSync(file)) process.exit(1)
  process.stdout.write(readFileSync(file, 'utf8'))
  process.exit(0)
}

// Antigravity takes the prompt as the value of -p; the others read it from stdin.
let prompt = ''
if (runtime === 'antigravity') prompt = args[args.indexOf('-p') + 1] ?? ''
else {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) prompt += chunk
}

// Claude Code reads the owner's instructions from a file (PLAN 8.8): remember what was in it and how it was protected.
const appendedPath = args[args.indexOf('--append-system-prompt-file') + 1]
const appended =
  args.includes('--append-system-prompt-file') && appendedPath
    ? {
        path: appendedPath,
        mode: (statSync(appendedPath).mode & 0o777).toString(8),
        content: readFileSync(appendedPath, 'utf8'),
      }
    : null
const SEPARATOR = '\n\n---\n\n'
// What this launch was given as the owner's instructions: the file, or the block in front of the first message.
const received =
  appended?.content ??
  (prompt.includes(SEPARATOR) && /^Your (name in this team|instructions were updated)/.test(prompt)
    ? prompt.slice(0, prompt.indexOf(SEPARATOR))
    : '')

const log = process.env.SCORE_CODING_FAKE_LOG
if (log)
  appendFileSync(
    log,
    `${JSON.stringify({
      runtime,
      args,
      cwd: process.cwd(),
      prompt,
      appended,
      env: Object.keys(process.env).sort(),
      pid: process.pid,
    })}\n`,
  )

// `agy models` lists the models without a prompt (real output captured 2026-10-16).
if (runtime === 'antigravity' && args[0] === 'models') {
  process.stdout.write(readFileSync(join(here, 'antigravity-models.txt'), 'utf8'))
  process.exit(0)
}

if (runtime === 'antigravity' && prompt === '/usage') {
  const usage = JSON.parse(readFileSync(join(here, 'antigravity-usage.json'), 'utf8'))
  delete usage._fixture
  process.stdout.write(`${JSON.stringify(usage)}\n`)
  process.exit(0)
}

const name = /\[fixture:([a-z-]+)\]/.exec(prompt)?.[1] ?? 'basic'
// A resumed turn may have its own fixture (`<name>-resumed`): lets tests make a resume fail.
const resumed =
  args.includes('--resume') || args.includes('resume') || args.includes('--conversation')
const base = join(here, `${fixtureNames[runtime]}-${name}`)
const file =
  resumed && existsSync(`${base}-resumed.jsonl`) ? `${base}-resumed.jsonl` : `${base}.jsonl`
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
// Codex also writes its own session log under $CODEX_HOME; the quota meter reads the `rate_limits` line of this run's file.
if (runtime === 'codex' && process.env.CODEX_HOME && !process.env.SCORE_CODING_FAKE_NO_CODEX_LOG) {
  const thread = lines
    .map((line) => /"thread_id":"([^"]+)"/.exec(line)?.[1])
    .find((value) => value !== undefined)
  if (thread) {
    const now = new Date()
    const two = (value) => String(value).padStart(2, '0')
    const dir = join(
      process.env.CODEX_HOME,
      'sessions',
      String(now.getFullYear()),
      two(now.getMonth() + 1),
      two(now.getDate()),
    )
    mkdirSync(dir, { recursive: true })
    const entry = (payload) =>
      `${JSON.stringify({ timestamp: now.toISOString(), type: 'event_msg', payload })}\n`
    writeFileSync(
      join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${thread}.jsonl`),
      entry({ type: 'task_started' }) +
        entry({
          type: 'token_count',
          info: null,
          rate_limits: {
            primary: {
              used_percent: 12.0,
              window_minutes: 300,
              resets_at: Math.floor(Date.now() / 1000) + 9000,
            },
            secondary: {
              used_percent: 41.0,
              window_minutes: 10080,
              resets_at: Math.floor(Date.now() / 1000) + 400000,
            },
          },
        }),
    )
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
process.on('SIGINT', () => process.exit(130))
for (const line of lines) {
  const directive = JSON.parse(line.startsWith('{"_') ? line : '{}')
  if (directive._fixture) continue
  if (directive._sleep) await sleep(directive._sleep)
  else if (directive._hang) await sleep(600_000)
  // A tool the CLI started and left running (same process group), for this many ms.
  else if (directive._orphan)
    spawn(process.execPath, ['-e', `setTimeout(() => {}, ${directive._orphan})`], {
      stdio: 'ignore',
    }).unref()
  else if (directive._stderr !== undefined)
    process.stderr.write(
      directive._stderr.replace(/\{\{PAD:(\d+)\}\}/g, (_, count) => 'v'.repeat(Number(count))),
    )
  else if (directive._raw !== undefined) process.stdout.write(directive._raw)
  else if (directive._exit !== undefined) process.exit(directive._exit)
  // `{{PAD:n}}` stands for n filler characters, so a fixture can carry a very large tool result.
  else
    process.stdout.write(
      `${line
        .replace(/\{\{PAD:(\d+)\}\}/g, (_, count) => 'v'.repeat(Number(count)))
        .replaceAll('{{RECEIVED}}', () => JSON.stringify(received || 'none').slice(1, -1))}\n`,
    )
}
