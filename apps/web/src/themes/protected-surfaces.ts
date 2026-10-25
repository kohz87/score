// What a theme may never restyle or hide (design §4.3). The class names are the components' own; `data-protected`
// marks the same elements in the markup. The CSS sanitiser drops any theme rule that names one of these, and
// styles/protected.css re-asserts their look from a cascade layer.
export const protectedClasses = [
  // Approval and decision cards: tool approvals, gates, limits, unknown cost, coding reach
  'chat-approval',
  'orch-decision',
  'orch-needs',
  'orch-fence',
  'reports-approvals',
  'watch-approval',
  'orch-ack',
  // The consent forms: starting a run (policy, reach, spend, limits, the button), MCP access, remote access, pairing
  'orch-workers',
  'orch-approvals',
  'orch-spend',
  'orch-limits',
  'orch-start',
  'team-mcp-access',
  'settings-remote',
  'pair-card',
  // Needs-you markers
  'needs-you-dot',
  // PLAN 11.3: the bold shell's dock ring of an agent that needs you
  'bold-needs',
  // PLAN 11.12c: the phone tab bar's count of everything waiting in the room
  'bold-tab-count',
  // PLAN 11.12c: a replay cannot answer an approval, so it hands the person back to the live screen
  'bold-screen-needs-live',
  // PLAN 11.10b: first run asks for the lead, the service choice and the starter recipes
  'bold-first-run-decision',
  // PLAN 11.10c: Start a job's checks and acknowledgement, and the trigger secret shown once
  'bold-start-dialog',
  'start-checks',
  'start-secret',
  // PLAN 11.9a: bold credential panels, the Add tool server form, and trigger secrets / rotate-delete decisions
  'bold-connect-panel',
  'bold-tool-add',
  // 2.0.3: the inline confirm before removing a provider, tool server or messaging connection
  'bold-remove-confirm',
  // 2.0.5: Remove agent… on the agent page (preview, typed name, progress)
  'bold-remove-agent',
  // 2.0.6: what an agent that is setting up, stopped or being removed says, with Retry / Confirm
  'bold-agent-status',
  'bold-trigger-card',
  'bold-trigger-secret',
  'bold-trigger-confirm',
  'orch-pill',
  'orch-node__flag',
  'bold-request',
  // PLAN 11.4b: the count that expands the rest of the needs-you strip (a theme may not hide the way to the cards)
  'bold-pins-more',
  // PLAN 11.11b: the shell-wide notice that starting work is blocked until the person reviews the fence
  'bold-fence-notice',
  // PLAN 11.4d: the room and job menus make destructive or exposing choices; deleting a room asks for its name.
  'bold-room-menu',
  'bold-job-menu',
  'bold-room-delete-dialog',
  // PLAN 11.12b: a job's lifecycle (rename, delete confirmation, undo, still-working notice) and report-back
  'bold-job-rename-dialog',
  'bold-job-delete-dialog',
  'bold-job-undo',
  'bold-job-lifecycle-notice',
  'bold-report-back',
  // PLAN 11.7: the privacy label, the share chooser, Add someone, and a shared one-to-one copy in the team room
  'bold-dm-privacy',
  'bold-dm-share-menu',
  'bold-dm-add',
  'bold-shared',
  // PLAN 11.9d: a trigger-started job's "Started by" card in the team room
  'bold-source',
  // PLAN 11.4c: the thread's confirmation before stopping a job
  'bold-thread-stop-confirm',
  // Permission, sandbox and password screens
  'rules-card',
  'team-permissions',
  'team-coding-permission',
  'coding-reach',
  'coding-acknowledge',
  'coding-add-context',
  'coding-add-commit',
  'bold-add-confirm',
  'bold-add-error',
  'bold-add-blockers',
  'bold-add-reuse',
  'bold-add-joined-runs',
  'terminal-auth',
  'security-password',
  // Agent identity and error toasts
  'agent-glyph',
  'chat-toast',
  // The way back
  'command-run',
  'command-palette',
  'command-trigger',
  'menu-trigger',
  'cz-back',
  'cz-error-back',
  'look-reset',
  'look-banner',
] as const

/** The custom properties a theme's CSS may not set: agent identity and the rules colours carry meaning. */
export const protectedCustomPropertyPrefixes = [
  '--agent-',
  '--rules-',
  '--glyph-',
  '--watch-live',
] as const
