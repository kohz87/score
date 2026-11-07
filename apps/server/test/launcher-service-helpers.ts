import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach } from 'vitest'

// The real launcher (bash) against a temp repo skeleton, a temp home and fake systemctl/loginctl. Nothing here may touch
// the real user manager, ~/.config or ~/.score. SCORE_TEST_LAUNCHER lets the failing-first run use an older script.
const launcher =
  process.env.SCORE_TEST_LAUNCHER ??
  fileURLToPath(new URL('../../../scripts/score', import.meta.url))

const STUB_START = `
import { writeFileSync } from 'node:fs'
const home = process.env.SCORE_HOME
writeFileSync(home + '/stub-env.json', JSON.stringify(process.env))
writeFileSync(home + '/pair-link', 'http://127.0.0.1:1/pair#TOKEN', { mode: 0o600 })
console.log('Pair this browser: http://127.0.0.1:1/ (link withheld from logs; use scripts/score pair)')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

// Records every call, keeps state in $FAKE_STATE, and starts `scripts/score run` the way systemd would (env file only).
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
set -u
echo "$*" >>"$FAKE_STATE/calls.log"
[[ "\${1:-}" == "--user" ]] || exit 9
shift
verb="\${1:-}"; shift || true
pidfile="$FAKE_STATE/mainpid"
alive() { [[ -f "$pidfile" ]] && kill -0 "$(<"$pidfile")" 2>/dev/null; }
launch() {
  env -i HOME="$HOME" PATH="$PATH" FAKE_ROOT="$FAKE_ROOT" INVOCATION_ID=fake-invocation SCORE_SYSTEMD_USER_DIR="\${SCORE_SYSTEMD_USER_DIR:-}" SCORE_CONFIG_DIR="\${SCORE_CONFIG_DIR:-}" bash -c '
    set -a; . "$HOME/cfg/score.env"; set +a
    exec "$FAKE_ROOT/scripts/score" run >>"$SCORE_HOME/score.log" 2>&1' </dev/null 9>&- &
  echo $! >"$pidfile"
}
halt() { if alive; then kill -TERM "$(<"$pidfile")"; for _ in $(seq 50); do alive || break; sleep 0.1; done; fi; rm -f "$pidfile"; }
[[ ",\${FAKE_FAIL:-}," != *",$verb,"* ]] || exit 1
case "$verb" in
  show-environment) [[ -z "\${FAKE_NO_MANAGER:-}" ]] || exit 1 ;;
  daemon-reload) ;;
  enable) touch "$FAKE_STATE/enabled"; [[ " $* " != *" --now "* ]] || { alive || launch; } ;;
  disable) rm -f "$FAKE_STATE/enabled"; [[ " $* " != *" --now "* ]] || halt ;;
  start) alive || launch ;;
  stop) halt ;;
  restart) halt; launch ;;
  is-active) if alive; then [[ " $* " == *" --quiet "* ]] || echo active; else [[ " $* " == *" --quiet "* ]] || echo inactive; exit 3; fi ;;
  is-failed) exit 1 ;;
  is-enabled) if [[ -f "$FAKE_STATE/enabled" ]]; then echo enabled; else echo disabled; exit 1; fi ;;
  show) alive && cat "$pidfile" || echo 0 ;;
  *) exit 0 ;;
esac
`
const FAKE_LOGINCTL = `#!/usr/bin/env bash
echo "loginctl $*" >>"$FAKE_STATE/calls.log"
echo "\${FAKE_LINGER:-no}"
`

export interface Rig {
  root: string
  home: string
  unitDir: string
  cfgDir: string
  state: string
  env: Record<string, string>
}
let rigs: Rig[] = []
export const spawned: ChildProcess[] = []

export function makeRig(extra: Record<string, string> = {}): Rig {
  const base = mkdtempSync(join(tmpdir(), 'score-launcher-'))
  const root = join(base, 'repo')
  const rig: Rig = {
    root,
    home: join(base, 'score-home'),
    unitDir: join(base, 'unit'),
    cfgDir: join(base, 'cfg'),
    state: join(base, 'state'),
    env: {},
  }
  for (const dir of [
    join(root, 'scripts'),
    join(root, 'apps/web/dist'),
    rig.state,
    join(base, 'fake'),
  ])
    mkdirSync(dir, { recursive: true })
  copyFileSync(launcher, join(root, 'scripts/score'))
  chmodSync(join(root, 'scripts/score'), 0o755)
  writeFileSync(join(root, 'scripts/start.mjs'), STUB_START)
  writeFileSync(join(root, 'apps/web/dist/index.html'), '<html></html>')
  writeFileSync(join(base, 'fake/systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 })
  writeFileSync(join(base, 'fake/loginctl'), FAKE_LOGINCTL, { mode: 0o755 })
  rig.env = {
    PATH: process.env.PATH!,
    HOME: base,
    USER: 'tester',
    SCORE_HOME: rig.home,
    SCORE_SYSTEMD_USER_DIR: rig.unitDir,
    SCORE_CONFIG_DIR: rig.cfgDir,
    SCORE_SYSTEMCTL: join(base, 'fake/systemctl'),
    SCORE_LOGINCTL: join(base, 'fake/loginctl'),
    FAKE_STATE: rig.state,
    FAKE_ROOT: root,
    ...extra,
  }
  // The fake reads the env file from $HOME/cfg.
  rigs.push(rig)
  return rig
}

export function score(rig: Rig, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(
      join(rig.root, 'scripts/score'),
      args,
      { env: { ...rig.env, ...env }, timeout: 60_000 },
      (error, out, err) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, out, err })
      },
    )
  })
}

export const calls = (rig: Rig) =>
  existsSync(join(rig.state, 'calls.log')) ? readFileSync(join(rig.state, 'calls.log'), 'utf8') : ''
export const pidOf = (rig: Rig) => Number(readFileSync(join(rig.home, 'score.pid'), 'utf8'))
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  rigs = []
})
afterEach(async () => {
  for (const rig of rigs) {
    // Only the pids this test started: the pid file and the fake's main pid.
    for (const file of [join(rig.home, 'score.pid'), join(rig.state, 'mainpid')]) {
      try {
        const pid = Number(readFileSync(file, 'utf8'))
        if (pid > 1) process.kill(pid, 'SIGKILL')
      } catch {
        /* not running */
      }
    }
    rmSync(join(rig.root, '..'), { recursive: true, force: true })
  }
  for (const child of spawned.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
})

export const installEnv = { SCORE_MODE: 'fake', SCORE_PORT: '18123', SECRET_X: 'leak-me' }

// --- 10.14: the offer on the first terminal start --------------------------------------------------------------
export const QUESTION =
  'Run Score as a service, so it starts at boot and restarts after a crash? [Y/n]'

// Runs the launcher on a pseudo-terminal (util-linux `script`); each answer is typed after the previous question shows.
export function scoreOnTerminal(
  rig: Rig,
  args: string[],
  answers: string[],
  env: Record<string, string> = {},
) {
  return new Promise<{ code: number; out: string; asked: number }>((resolve) => {
    const child = spawn(
      'script',
      ['-qec', [join(rig.root, 'scripts/score'), ...args].join(' '), '/dev/null'],
      { env: { ...rig.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    spawned.push(child)
    let out = ''
    let asked = 0
    let given = 0
    const feed = () => {
      const count = out.split(QUESTION).length - 1
      asked = count
      while (given < count && given < answers.length) child.stdin.write(`${answers[given++]}\n`)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      feed()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('close', (code) => resolve({ code: code ?? 1, out: out.replaceAll('\r', ''), asked }))
  })
}
export const remembered = (rig: Rig) => join(rig.home, 'service-prompt')
