import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

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
  env -i HOME="$HOME" PATH="$PATH" FAKE_ROOT="$FAKE_ROOT" bash -c '
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

interface Rig {
  root: string
  home: string
  unitDir: string
  cfgDir: string
  state: string
  env: Record<string, string>
}
let rigs: Rig[] = []
const spawned: ChildProcess[] = []

function makeRig(extra: Record<string, string> = {}): Rig {
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

function score(rig: Rig, args: string[], env: Record<string, string> = {}) {
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

const calls = (rig: Rig) =>
  existsSync(join(rig.state, 'calls.log')) ? readFileSync(join(rig.state, 'calls.log'), 'utf8') : ''
const pidOf = (rig: Rig) => Number(readFileSync(join(rig.home, 'score.pid'), 'utf8'))
const alive = (pid: number) => {
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

const installEnv = { SCORE_MODE: 'fake', SCORE_PORT: '18123', SECRET_X: 'leak-me' }

test('run: foreground, writes its own pid, becomes the server, refuses a second copy', async () => {
  const rig = makeRig()
  const first = spawn(join(rig.root, 'scripts/score'), ['run'], { env: rig.env, stdio: 'ignore' })
  spawned.push(first)
  for (let i = 0; i < 100 && !existsSync(join(rig.home, 'stub-env.json')); i++)
    await new Promise((resolve) => setTimeout(resolve, 100))
  const env = JSON.parse(readFileSync(join(rig.home, 'stub-env.json'), 'utf8')) as Record<
    string,
    string
  >
  expect(env.SCORE_SERVE_WEB).toBe('1')
  expect(env.SCORE_LOG_FILE).toBe(join(rig.home, 'score.log'))
  expect(pidOf(rig)).toBe(first.pid)
  expect(readFileSync(join(rig.home, 'score.log'), 'utf8')).toContain('Pair this browser')
  const second = await score(rig, ['run'])
  expect(second.code).not.toBe(0)
  expect(second.err).toMatch(/already running/)
  first.kill('SIGTERM')
}, 30_000)

test('run refuses when the web app is not built', async () => {
  const rig = makeRig()
  rmSync(join(rig.root, 'apps/web/dist'), { recursive: true })
  const result = await score(rig, ['run'])
  expect(result.code).toBe(1)
  expect(result.err).toMatch(/not built yet/)
})

test('service install writes the unit and a private env file, starts it, and passes only SCORE_* and PATH', async () => {
  const rig = makeRig()
  const result = await score(rig, ['service', 'install'], installEnv)
  expect(result.err).toMatch(/enable-linger tester/)
  expect(result.out).toMatch(/Score started/)
  expect(result.out).toMatch(/Pair this browser: http:\/\/127\.0\.0\.1:1\/pair#TOKEN/)
  const unit = readFileSync(join(rig.unitDir, 'score.service'), 'utf8')
  expect(unit).toContain(`WorkingDirectory=${rig.root}`)
  expect(unit).toContain(`ExecStart=${rig.root}/scripts/score run`)
  expect(unit).toContain(`EnvironmentFile=${join(rig.cfgDir, 'score.env')}`)
  for (const line of [
    'Type=simple',
    'Restart=on-failure',
    'RestartSec=5',
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    'KillMode=mixed',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=60',
    'WantedBy=default.target',
    `StandardOutput=append:${rig.home}/score.log`,
    `StandardError=append:${rig.home}/score.log`,
  ])
    expect(unit).toContain(line)
  const envFile = join(rig.cfgDir, 'score.env')
  expect(statSync(envFile).mode & 0o777).toBe(0o600)
  expect(statSync(rig.cfgDir).mode & 0o777).toBe(0o700)
  const text = readFileSync(envFile, 'utf8')
  expect(text).toContain(`SCORE_HOME="${rig.home}"`)
  expect(text).toContain('SCORE_MODE="fake"')
  expect(text).toContain('SCORE_PORT="18123"')
  expect(text).toContain(`PATH="${process.env.PATH}"`)
  expect(text).not.toMatch(/SECRET_X|leak-me|USER=|SCORE_SYSTEMCTL|SCORE_CONFIG_DIR/)
  expect(
    text
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('=')[0])
      .sort(),
  ).toEqual(['PATH', 'SCORE_HOME', 'SCORE_MODE', 'SCORE_PORT'].sort())
  expect(calls(rig)).toMatch(/--user daemon-reload[\s\S]*--user enable --now score/)
  expect(alive(pidOf(rig))).toBe(true)
}, 60_000)

test('service install quotes values for systemd and refuses a line break', async () => {
  const rig = makeRig()
  const bad = await score(rig, ['service', 'install'], { SCORE_PUBLIC_ORIGINS: 'a\nb' })
  expect(bad.code).toBe(1)
  expect(bad.err).toMatch(/SCORE_PUBLIC_ORIGINS contains a line break/)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(false)
  expect(existsSync(join(rig.cfgDir, 'score.env'))).toBe(false)
  const ok = await score(rig, ['service', 'install'], { SCORE_X_NOTE: 'say "hi" \\ there' })
  expect(ok.code).toBe(0)
  expect(readFileSync(join(rig.cfgDir, 'score.env'), 'utf8')).toContain(
    'SCORE_X_NOTE="say \\"hi\\" \\\\ there"',
  )
}, 60_000)

test('service install: no linger warning when linger is on; refuses without a user manager', async () => {
  const rig = makeRig({ FAKE_LINGER: 'yes' })
  const ok = await score(rig, ['service', 'install'], installEnv)
  expect(ok.code).toBe(0)
  expect(ok.err).not.toMatch(/linger/)
  const other = makeRig({ FAKE_NO_MANAGER: '1' })
  const refused = await score(other, ['service', 'install'], installEnv)
  expect(refused.code).toBe(1)
  expect(refused.err).toMatch(/user manager/)
  expect(existsSync(join(other.unitDir, 'score.service'))).toBe(false)
}, 60_000)

test('service install refuses while a launcher-started Score runs', async () => {
  const rig = makeRig()
  const started = await score(rig, ['start'], installEnv)
  expect(started.code).toBe(0)
  const result = await score(rig, ['service', 'install'], installEnv)
  expect(result.code).toBe(1)
  expect(result.err).toMatch(/scripts\/score stop/)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(false)
  expect((await score(rig, ['stop'])).out).toMatch(/Score stopped/)
}, 60_000)

test('without the unit, start/stop/restart/status behave as before and never call systemctl', async () => {
  const rig = makeRig()
  expect((await score(rig, ['status'])).out).toMatch(/not running/)
  const started = await score(rig, ['start'], installEnv)
  expect(started.out).toMatch(/Score started/)
  const first = pidOf(rig)
  expect((await score(rig, ['status'])).out).toMatch(/Score is running \(pid \d+\)/)
  const restarted = await score(rig, ['restart'], installEnv)
  expect(restarted.out).toMatch(/Score stopped\.[\s\S]*Score started/)
  expect(pidOf(rig)).not.toBe(first)
  expect((await score(rig, ['stop'])).out).toMatch(/Score stopped/)
  expect(calls(rig)).toBe('')
}, 60_000)

test('with the unit installed, start/stop/restart/status go through systemctl', async () => {
  const rig = makeRig()
  await score(rig, ['service', 'install'], installEnv)
  const log = () => calls(rig)
  const status = await score(rig, ['status'])
  expect(status.out).toMatch(/running as a service/)
  expect((await score(rig, ['start'])).out).toMatch(/already running as a service/)
  const stopped = await score(rig, ['stop'])
  expect(stopped.out).toMatch(/Score stopped/)
  expect(log()).toMatch(/--user stop score/)
  expect((await score(rig, ['status'])).code).toBe(1)
  const started = await score(rig, ['start'])
  expect(started.out).toMatch(/Score started/)
  expect(started.out).toMatch(/Pair this browser/)
  expect(log()).toMatch(/--user start score/)
  const before = pidOf(rig)
  const restarted = await score(rig, ['restart'])
  expect(restarted.out).toMatch(/Score started/)
  expect(log()).toMatch(/--user restart score/)
  expect(pidOf(rig)).not.toBe(before)
  // pair keeps working against the service's process
  expect((await score(rig, ['logs'])).out).toMatch(/Pair this browser/)
}, 90_000)

test('with the unit installed, start refuses beside a launcher-started copy', async () => {
  const rig = makeRig()
  await score(rig, ['service', 'install'], installEnv)
  await score(rig, ['stop'])
  // a copy started by hand (not by systemd) on the same home
  const stray = spawn(join(rig.root, 'scripts/score'), ['run'], {
    env: { ...rig.env, SCORE_MODE: 'fake' },
    stdio: 'ignore',
  })
  spawned.push(stray)
  for (let i = 0; i < 100 && !existsSync(join(rig.home, 'pair-link')); i++)
    await new Promise((resolve) => setTimeout(resolve, 100))
  const result = await score(rig, ['start'])
  expect(result.code).toBe(1)
  expect(result.err).toMatch(/launcher/)
  expect(calls(rig)).not.toMatch(/--user start score/)
  stray.kill('SIGTERM')
}, 60_000)

test('reinstall updates the files, says what changed, and restarts', async () => {
  const rig = makeRig()
  await score(rig, ['service', 'install'], installEnv)
  const first = pidOf(rig)
  const again = await score(rig, ['service', 'install'], { ...installEnv, SCORE_PORT: '18999' })
  expect(again.code).toBe(0)
  expect(again.out).toMatch(/Environment file updated.*changed: SCORE_PORT/)
  expect(again.out).not.toMatch(/18999|18123/)
  expect(again.out).toMatch(/Unit file unchanged/)
  expect(readFileSync(join(rig.cfgDir, 'score.env'), 'utf8')).toContain('SCORE_PORT="18999"')
  expect(calls(rig)).toMatch(/--user restart score/)
  expect(pidOf(rig)).not.toBe(first)
}, 90_000)

test('service status reports state, pid, URL and linger', async () => {
  const rig = makeRig({ FAKE_LINGER: 'yes' })
  const none = await score(rig, ['service', 'status'])
  expect(none.code).toBe(1)
  await score(rig, ['service', 'install'], installEnv)
  const result = await score(rig, ['service', 'status'])
  expect(result.out).toMatch(/State:\s+active/)
  expect(result.out).toMatch(/Enabled:\s+enabled/)
  expect(result.out).toMatch(new RegExp(`MainPID:\\s+${pidOf(rig)}`))
  expect(result.out).toMatch(/URL:\s+http:\/\/127\.0\.0\.1:1/)
  expect(result.out).toMatch(/Linger:\s+yes/)
}, 60_000)

test('uninstall keeps the env file, --purge removes it', async () => {
  const rig = makeRig()
  await score(rig, ['service', 'install'], installEnv)
  const pid = pidOf(rig)
  const kept = await score(rig, ['service', 'uninstall'])
  expect(kept.code).toBe(0)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(false)
  expect(existsSync(join(rig.cfgDir, 'score.env'))).toBe(true)
  expect(kept.out).toMatch(/Kept .*score\.env/)
  expect(calls(rig)).toMatch(/--user disable --now score/)
  expect(alive(pid)).toBe(false)
  await score(rig, ['service', 'install'], installEnv)
  const purged = await score(rig, ['service', 'uninstall', '--purge'])
  expect(purged.code).toBe(0)
  expect(existsSync(join(rig.cfgDir, 'score.env'))).toBe(false)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(false)
}, 90_000)

test('the instance lock keeps a second copy out for the server whole life (run and start)', async () => {
  const rig = makeRig()
  mkdirSync(rig.home, { recursive: true })
  // Hold the lock the way a live server would, without being recognisable as start.mjs.
  const holder = spawn('flock', ['-n', join(rig.home, 'score.instance.lock'), 'sleep', '60'], {
    stdio: 'ignore',
  })
  spawned.push(holder)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const run = await score(rig, ['run'])
  expect(run.code).not.toBe(0)
  expect(run.err).toMatch(/Another Score/)
  const start = await score(rig, ['start'])
  expect(start.code).not.toBe(0)
  expect(start.err).toMatch(/Another Score/)
  holder.kill('SIGKILL')
}, 30_000)

test('two runs at once leave exactly one server', async () => {
  const rig = makeRig()
  const a = score(rig, ['run'], { SCORE_PORT: '1' })
  const b = score(rig, ['run'], { SCORE_PORT: '2' })
  // The loser exits at once; the winner keeps running until the afterEach kills it.
  const settled = await Promise.race([a, b])
  expect(settled.code).not.toBe(0)
  expect(settled.err).toMatch(/already running|Another Score/)
}, 30_000)

test('uninstall keeps everything and fails when stopping fails', async () => {
  const rig = makeRig()
  await score(rig, ['service', 'install'], installEnv)
  const pid = pidOf(rig)
  const failed = await score(rig, ['service', 'uninstall', '--purge'], { FAKE_FAIL: 'disable' })
  expect(failed.code).toBe(1)
  expect(failed.err).toMatch(/Could not stop/)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(true)
  expect(existsSync(join(rig.cfgDir, 'score.env'))).toBe(true)
  expect(alive(pid)).toBe(true)
  const reload = await score(rig, ['service', 'uninstall', '--purge'], {
    FAKE_FAIL: 'daemon-reload',
  })
  expect(reload.code).toBe(1)
  expect(reload.err).toMatch(/daemon-reload failed/)
  expect(existsSync(join(rig.unitDir, 'score.service'))).toBe(true)
  expect(existsSync(join(rig.cfgDir, 'score.env'))).toBe(true)
}, 90_000)

test('restart and reinstall find the ready line after the log is rotated past 10 MB', async () => {
  const rig = makeRig()
  await score(rig, ['service', 'install'], installEnv)
  const log = join(rig.home, 'score.log')
  const big = () => writeFileSync(log, Buffer.alloc(10_500_000, 97))
  big()
  const restarted = await score(rig, ['restart'])
  expect(restarted.code).toBe(0)
  expect(restarted.out).toMatch(/Score started/)
  expect(existsSync(`${log}.1`)).toBe(true)
  big()
  const again = await score(rig, ['service', 'install'], installEnv)
  expect(again.code).toBe(0)
  expect(again.out).toMatch(/Score started/)
}, 90_000)

test('a fresh shell without SCORE_HOME follows the installed service’s home (read, never sourced)', async () => {
  const rig = makeRig()
  expect((await score(rig, ['service', 'install'], installEnv)).code).toBe(0)
  const fresh: Record<string, string> = { ...rig.env }
  delete fresh.SCORE_HOME
  const result = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(
      join(rig.root, 'scripts/score'),
      ['restart'],
      { env: fresh, timeout: 60_000 },
      (error, out, err) =>
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err }),
    )
  })
  expect(result.err).toBe('')
  expect(result.code).toBe(0)
  expect(result.out).toMatch(/Score (re)?started/)
}, 90_000)

test('a manual start, restart or reinstall clears systemd’s start limit first', async () => {
  const rig = makeRig()
  await score(rig, ['service', 'install'], installEnv)
  await score(rig, ['restart'])
  expect(calls(rig)).toMatch(/--user reset-failed score\n[^\n]*--user restart score/)
}, 90_000)
