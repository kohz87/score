import { execFile } from 'node:child_process'

export interface ToolResult {
  /** Exit status; null when the tool could not run or timed out. */
  code: number | null
  stdout: string
  stderr: string
  /** Set when the tool did not run to completion (missing binary, timeout). */
  failed?: 'spawn' | 'timeout'
}
export type RunTool = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<ToolResult>

export const realRunTool: RunTool = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: options?.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
        if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr })
        resolve({ code: null, stdout, stderr, failed: e.killed ? 'timeout' : 'spawn' })
      },
    )
  })

export const SYSTEMD_RUN = '/usr/bin/systemd-run'
export const SYSTEMCTL = '/usr/bin/systemctl'
export const LOGINCTL = '/usr/bin/loginctl'
export const ENV_BIN = '/usr/bin/env'
export const PINNED_PATH = '/usr/local/bin:/usr/bin:/bin'
export const CGROUP_ROOT = '/sys/fs/cgroup'

/** Design section 1: the concrete deny list, always applied whether or not the manager exports the names. */
export const ENV_DENY_LIST: readonly string[] = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',
  'LD_DEBUG',
  'LD_PROFILE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_ICU_DATA',
  'NODE_V8_COVERAGE',
  'NODE_DEBUG',
  'NODE_PENDING_DEPRECATION',
  'NODE_REDIRECT_WARNINGS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_COMPILE_CACHE',
  'NODE_DISABLE_COMPILE_CACHE',
  'UV_THREADPOOL_SIZE',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'MALLOC_CHECK_',
  'MALLOC_PERTURB_',
  'GCONV_PATH',
  'LOCPATH',
  'TZDIR',
  'HOSTALIASES',
  'RES_OPTIONS',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
]

/** Set explicitly (never listed: UnsetEnvironment applies last), or owned by systemd itself. */
const NEVER_UNSET = new Set(['PATH', 'HOME', 'LANG', 'NOTIFY_SOCKET'])
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The deny list for `UnsetEnvironment`: the concrete list plus whatever the manager exports (except the exempt names). */
export function unsetEnvironmentList(managerEnvNames: readonly string[] = []): string[] {
  const names = new Set(ENV_DENY_LIST)
  for (const name of managerEnvNames)
    if (ENV_NAME.test(name) && !NEVER_UNSET.has(name)) names.add(name)
  return [...names]
}
