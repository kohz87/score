import { CODING_EFFORTS } from '@score/contract'
import { join } from 'node:path'
import { inRoots } from './worker-sources.ts'
import { checkedEffort } from './types.ts'
import { createCodexParser } from './codex-parser.ts'
import type { CodingDriver, DriverRunOptions } from './types.ts'

const CODEX_EFFORTS = CODING_EFFORTS.codex!

const SANDBOX = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  full: 'danger-full-access',
} as const

export const codexDriver: CodingDriver = {
  runtime: 'codex',
  resumeRefusal: /^(?:thread\/resume failed: )?no rollout found for thread id\b/i,
  label: 'Codex',
  executable: 'codex',
  testedVersions: ['0.160.1'],
  supported: true,
  quota: 'Uses your ChatGPT plan quota, shared with other Codex work on that account.',
  promptVia: 'stdin',
  verifiedPermissions: ['read-only', 'workspace-write', 'full'],
  warning: null,
  requiresReadAck: () => true,
  parseVersion(output) {
    return /codex-cli\s+(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
  },
  buildArgs(options: DriverRunOptions) {
    const sandbox = SANDBOX[options.permission]
    // The prompt arrives on stdin (`-`). `exec resume` has no -s/-C: it takes the sandbox as a config override and
    // works in the process's own folder (the workspace).
    if (options.sessionId) {
      const args = [
        'exec',
        'resume',
        options.sessionId,
        '--json',
        '--skip-git-repo-check',
        '-c',
        `sandbox_mode="${sandbox}"`,
        '-c',
        'approval_policy="never"',
      ]
      if (options.model) args.push('-m', options.model)
      const effort = checkedEffort(options.effort, CODEX_EFFORTS)
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
      args.push('-')
      return args
    }
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      // A worker reads neither the person's own config.toml nor their execution rules (7.7b §3).
      ...(options.worker ? ['--ignore-user-config', '--ignore-rules'] : []),
      '-s',
      sandbox,
      '-C',
      options.workspace,
      '-c',
      'approval_policy="never"',
    ]
    if (options.model) args.push('-m', options.model)
    const effort = checkedEffort(options.effort, CODEX_EFFORTS)
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
    args.push('-')
    return args
  },
  worker: {
    // Checked against `codex exec --help` of 0.160.1 (the installed and pinned CLI, 2026-10-13).
    versions: ['0.160.1'],
    neutralised: [
      {
        source: 'the user’s $CODEX_HOME/config.toml',
        flag: '--ignore-user-config',
        evidence:
          '"--ignore-user-config  Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`"',
      },
      {
        source: 'execution rules (.rules files, user and project)',
        flag: '--ignore-rules',
        evidence: '"--ignore-rules  Do not load user or project execpolicy `.rules` files"',
      },
    ],
    help: {
      args: ['exec', '--help'],
      // The wording of 0.160.1, unchanged in 0.164.0 (2026-10-27).
      flags: [
        { flag: '--config', phrases: ['Override a configuration value'] },
        { flag: '--model', phrases: ['Model the agent should use'] },
        {
          flag: '--sandbox',
          phrases: [
            'Select the sandbox policy to use when executing model-generated shell commands',
            'read-only',
            'workspace-write',
          ],
        },
        { flag: '--cd', phrases: ['use the specified directory as its working root'] },
        {
          flag: '--skip-git-repo-check',
          phrases: ['Allow running Codex outside a Git repository'],
        },
        {
          flag: '--ignore-user-config',
          phrases: ['Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`'],
        },
        {
          flag: '--ignore-rules',
          phrases: ['Do not load user or project execpolicy `.rules` files'],
        },
        { flag: '--json', phrases: ['Print events to stdout as JSONL'] },
      ],
    },
    // The help documents no switch for the project's .codex/ folder, managed config or AGENTS.md files: bound by identity.
    bound: ({ home, workspace, env }) => {
      const codexHome = env['CODEX_HOME'] ?? join(home, '.codex')
      return [
        join(codexHome, 'config.toml'),
        join(codexHome, 'AGENTS.md'),
        join(codexHome, 'AGENTS.override.md'),
        join(codexHome, 'rules'),
        ...inRoots(workspace, '.codex', 'config.toml'),
        ...inRoots(workspace, '.codex', 'hooks.json'),
        ...inRoots(workspace, '.codex', 'rules'),
        ...inRoots(workspace, 'AGENTS.md'),
        ...inRoots(workspace, 'AGENTS.override.md'),
        '/etc/codex/config.toml',
        '/etc/codex/managed_config.toml',
        '/etc/codex/requirements.toml',
      ]
    },
    reach: (permission, workspace) =>
      permission === 'read-only'
        ? {
            text: `Reads any file you can read, not only the ones in ${workspace}. It can’t change files.`,
            beyondWorkspace: true,
          }
        : {
            text: `Reads any file you can read, not only the ones in ${workspace}, and changes files only inside ${workspace} and temporary folders.`,
            beyondWorkspace: true,
          },
  },
  createParser: (options) => createCodexParser(options.cwd),
}
