import { userInfo } from 'node:os'

export interface TerminalLaunch {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  user: string
}

const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin'

/**
 * What the shell starts with. Score's own environment (SCORE_* paths, ports, anything the launcher exported) is never
 * passed on: only these six variables, so the shell looks like a fresh login on this machine for this user.
 */
export function terminalLaunch(
  source: NodeJS.ProcessEnv = process.env,
  info: { username: string; homedir: string; shell: string | null } = userInfo(),
): TerminalLaunch {
  const shell = info.shell && info.shell.startsWith('/') ? info.shell : '/bin/bash'
  // The home directory comes from HOME when set (as os.homedir() does), else the account database.
  const home = source.HOME && source.HOME.startsWith('/') ? source.HOME : info.homedir
  return {
    file: shell,
    args: ['-l'],
    cwd: home,
    user: info.username,
    env: {
      HOME: home,
      USER: info.username,
      LANG: source.LANG && /^[\w.@-]{1,40}$/.test(source.LANG) ? source.LANG : 'C.UTF-8',
      PATH: source.PATH || FALLBACK_PATH,
      TERM: 'xterm-256color',
      SHELL: shell,
    },
  }
}
