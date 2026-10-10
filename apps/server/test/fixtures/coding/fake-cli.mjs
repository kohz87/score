#!/usr/bin/env node
// Stand-in for the coding CLIs in tests and fake mode (selected by SCORE_CODING_FAKE_CLI, honoured only in fake mode
// and under test). It never talks to a model: it prints a hand-made fixture selected by `[fixture:NAME]` in the prompt.
// Usage: node fake-cli.mjs <claude-code|codex|opencode> <the real CLI's arguments…>
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [runtime, ...args] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const fixtureNames = { 'claude-code': 'claude', codex: 'codex' }

if (args.includes('--version')) {
  const version = process.env.SCORE_CODING_FAKE_VERSION
  if (runtime === 'claude-code') console.log(`${version ?? '2.1.295'} (Claude Code)`)
  else if (runtime === 'codex') console.log(`codex-cli ${version ?? '0.160.1'}`)
  else process.exit(127)
  process.exit(0)
}

let prompt = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) prompt += chunk

const log = process.env.SCORE_CODING_FAKE_LOG
if (log)
  appendFileSync(
    log,
    `${JSON.stringify({
      runtime,
      args,
      cwd: process.cwd(),
      prompt,
      env: Object.keys(process.env).sort(),
      pid: process.pid,
    })}\n`,
  )

const name = /\[fixture:([a-z-]+)\]/.exec(prompt)?.[1] ?? 'basic'
// A resumed turn may have its own fixture (`<name>-resumed`): lets tests make a resume fail.
const resumed = args.includes('--resume') || args.includes('resume')
const base = join(here, `${fixtureNames[runtime]}-${name}`)
const file =
  resumed && existsSync(`${base}-resumed.jsonl`) ? `${base}-resumed.jsonl` : `${base}.jsonl`
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
process.on('SIGINT', () => process.exit(130))
for (const line of lines) {
  const directive = JSON.parse(line.startsWith('{"_') ? line : '{}')
  if (directive._fixture) continue
  if (directive._sleep) await sleep(directive._sleep)
  else if (directive._hang) await sleep(600_000)
  else if (directive._exit !== undefined) process.exit(directive._exit)
  else process.stdout.write(`${line}\n`)
}
