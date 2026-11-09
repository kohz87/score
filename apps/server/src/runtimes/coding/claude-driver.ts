import { CODING_EFFORTS } from '@score/contract'
import { join } from 'node:path'
import { checkedEffort } from './types.ts'
import { inRoots } from './worker-sources.ts'
import { createClaudeParser } from './claude-parser.ts'
import type { CodingDriver, DriverRunOptions } from './types.ts'

const CLAUDE_EFFORTS = CODING_EFFORTS['claude-code']!

/** Secret files nobody wants an agent to read, wherever they are. */
// `//` roots a pattern at the file system: a relative one would not reach parent folders or other projects.
// `.env*` covers .env, .env.local, .envrc and other suffixes.
const DENY_FILE_PATTERNS = ['//**/.env*']

const CLAUDE_DENY_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit'] as const

/**
 * What Claude Code may never read or write, whatever the permission level (review 2026-10-09, 7.2 #1b): the folders
 * Score is told are off limits (its own home, the Hermes home, ~/.ssh; `//` is Claude's absolute-path syntax) and
 * `.env` files.
 */
export function claudeDenyRules(
  denyPaths: readonly string[],
  denyFiles: readonly string[] = [],
): string[] {
  const folders = [...new Set(denyPaths)].map((folder) => `/${folder.replace(/\/+$/, '')}/**`)
  const files = denyFiles.map((file) => `/${file}`)
  // Claude Code applies Read rules to Grep/Glob and Edit rules to Write/NotebookEdit; every tool is listed anyway.
  return CLAUDE_DENY_TOOLS.flatMap((tool) =>
    [...folders, ...files, ...DENY_FILE_PATTERNS].map((pattern) => `${tool}(${pattern})`),
  )
}

// Shell use at `workspace-write`: only read-only git queries. Everything else a shell could do is refused by the CLI.
const WORKSPACE_ALLOWED = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(ls:*)',
]

export const claudeDriver: CodingDriver = {
  // A background sub-agent makes Claude Code report a second result, and one run has one result (claude-parser). With this
  // set the same request runs in the foreground: tested on 2.1.319 (docs/briefs/SA-subagents.md).
  runEnv: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
  runtime: 'claude-code',
  resumeRefusal: /^No conversation found with session ID\b/i,
  label: 'Claude Code',
  executable: 'claude',
  // 2.1.296: real read-only turns on 2026-10-13 (7.7a live check; captured record shapes in coding-drivers-verdicts.test.ts), owner
  // decision 77.
  // 2.1.301: real read-only turn on 2026-10-16 (owner-approved), record shapes unchanged. 2.1.302: a read-only turn and a
  // workspace-write turn with a sub-agent on 2026-10-17 (decision 95), both replayed without loss.
  testedVersions: ['2.1.295', '2.1.296', '2.1.301', '2.1.302'],
  supported: true,
  quota: 'Uses your Claude plan quota (the CLI’s own login).',
  promptVia: 'stdin',
  instructions: 'file',
  verifiedPermissions: ['read-only', 'workspace-write', 'full'],
  warning: null,
  requiresReadAck: () => false,
  parseVersion(output) {
    return /^(\d+\.\d+\.\d+)\b.*Claude Code/m.exec(output.trim())?.[1] ?? null
  },
  buildArgs(options: DriverRunOptions) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose']
    // Never answer a permission prompt: what the mode doesn't allow is refused.
    args.push('--permission-prompts', 'none')
    switch (options.permission) {
      case 'read-only':
        // Only the reading tools exist at all; dontAsk refuses anything else.
        args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob')
        break
      case 'workspace-write':
        args.push(
          '--permission-mode',
          'acceptEdits',
          '--allowed-tools',
          WORKSPACE_ALLOWED.join(','),
        )
        break
      case 'full':
        args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions')
        break
    }
    if (options.settingsPath) args.push('--settings', options.settingsPath)
    // A worker uses no MCP server the person configured for their own sessions (7.7b §3).
    if (options.worker) args.push('--strict-mcp-config')
    args.push(
      '--disallowed-tools',
      [
        ...claudeDenyRules(options.denyPaths, options.denyFiles),
        ...(options.subagentsOff ? ['Agent', 'Task'] : []),
      ].join(','),
    )
    if (options.model) args.push('--model', options.model)
    const effort = checkedEffort(options.effort, CLAUDE_EFFORTS)
    if (effort) args.push('--effort', effort)
    if (options.sessionId) args.push('--resume', options.sessionId)
    // The owner's role and instructions (PLAN 8.8): a file, never the text on argv. Claude Code records the system prompt
    // once per conversation, so a resumed session renders it fresh for an edit to apply (`claude --help`, 2.1.301).
    if (options.instructionsFile) args.push('--append-system-prompt-file', options.instructionsFile)
    if (options.refreshSystemPrompt) args.push('--system-prompt-snapshot', 'off')
    // Claude Code's own advisor (3.14.1; documented at code.claude.com/docs/en/advisor, not in `--help`). Not one of the
    // worker's checked flags: sent on every turn of an agent with its own advisor set, and a CLI without it fails that turn visibly.
    if (options.advisorModel) args.push('--advisor', options.advisorModel)
    return args
  },
  worker: {
    // Checked against `claude --help` of 2.1.296 (the installed CLI, 2026-10-13); 2.1.295 is the pinned test version.
    // 2.1.302: `--strict-mcp-config` and `--setting-sources` help text identical to 2.1.301 (2026-10-18).
    // 2.1.311 (the installed CLI, 2026-10-27): `--strict-mcp-config` and `--setting-sources` help text identical;
    // `--permission-mode` still offers dontAsk, acceptEdits and bypassPermissions (it adds auto and manual, never sent);
    // `--tools`, `--disallowed-tools`, `--settings`, `--system-prompt-snapshot`, `--resume` unchanged. New opt-in flags
    // (`--restricted`, `--safe-mode`) aren't used.
    versions: ['2.1.295', '2.1.296', '2.1.301', '2.1.302', '2.1.311'],
    neutralised: [
      {
        source: 'MCP servers (user, project, local and managed)',
        flag: '--strict-mcp-config',
        evidence:
          '"--strict-mcp-config  Only use MCP servers from --mcp-config, ignoring all other MCP configurations" (no --mcp-config is passed)',
      },
    ],
    // `--setting-sources` is documented ("Comma-separated list of setting sources to load (user, project, local)"), but the
    // help does not say what an empty list does, so the settings sources are bound by identity instead of switched off.
    bound: ({ home, workspace, env }) => {
      const config = env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude')
      return [
        join(config, 'settings.json'),
        join(config, 'CLAUDE.md'),
        ...inRoots(workspace, '.claude', 'settings.json'),
        ...inRoots(workspace, '.claude', 'settings.local.json'),
        ...inRoots(workspace, 'CLAUDE.md'),
        ...inRoots(workspace, 'CLAUDE.local.md'),
        ...inRoots(workspace, '.claude', 'CLAUDE.md'),
        '/etc/claude-code/managed-settings.json',
        '/etc/claude-code/CLAUDE.md',
      ]
    },
    help: {
      args: ['--help'],
      // The wording of 2.1.311 (2026-10-27). Lists that grow (permission modes) are checked for the entries Score uses.
      flags: [
        { flag: '--print', phrases: ['Print response and exit'] },
        { flag: '--output-format', phrases: ['"stream-json" (realtime streaming)'] },
        { flag: '--verbose', phrases: ['Override verbose mode setting from config'] },
        { flag: '--model', phrases: ['Model for the current session.'] },
        { flag: '--resume', phrases: ['Resume a conversation by session ID'] },
        {
          flag: '--permission-mode',
          phrases: ['Permission mode to use for the session', '"dontAsk"', '"acceptEdits"'],
        },
        {
          flag: '--permission-prompts',
          phrases: ['"none" (nobody: anything that would prompt is denied automatically'],
        },
        {
          flag: '--tools',
          phrases: [
            'Specify the list of available tools from the built-in set. Use "" to disable all tools',
          ],
        },
        { flag: '--disallowed-tools', phrases: ['list of tool names to deny'] },
        { flag: '--allowed-tools', phrases: ['list of tool names to allow'] },
        {
          flag: '--settings',
          phrases: [
            'Path to a settings JSON file or a JSON string to load additional settings from',
          ],
        },
        {
          flag: '--setting-sources',
          phrases: ['Comma-separated list of setting sources to load (user, project, local).'],
        },
        {
          flag: '--strict-mcp-config',
          phrases: [
            'Only use MCP servers from --mcp-config, ignoring all other MCP configurations',
          ],
        },
      ],
    },
    reach: (permission, workspace) =>
      permission === 'read-only'
        ? {
            text: `Reads files in ${workspace}. It can’t change files, run commands or use the network.`,
            beyondWorkspace: false,
          }
        : {
            text: `Reads and edits files in ${workspace}, and runs read-only git commands and ls there. Anything else it tries is refused.`,
            beyondWorkspace: false,
          },
  },
  createParser: (options) => createClaudeParser(options.cwd),
  settingsFile(denyPaths, denyFiles) {
    return {
      name: 'claude-settings.json',
      content: JSON.stringify(
        { permissions: { deny: claudeDenyRules(denyPaths, denyFiles) } },
        null,
        2,
      ),
    }
  },
}
