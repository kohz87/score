// What a theme may never restyle or hide (design §4.3). The class names are the components' own; `data-protected`
// marks the same elements in the markup. The CSS sanitiser drops any theme rule that names one of these, and
// styles/protected.css re-asserts their look from a cascade layer.
export const protectedClasses = [
  // Approval and decision cards: tool approvals, gates, limits, unknown cost, coding reach
  'chat-approval',
  'now-asking',
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
  // PLAN 11.10b: first run asks for the lead, the service choice and the starter recipes
  'bold-first-run-decision',
  'orch-pill',
  'orch-node__flag',
  // The task drawer's approval and its buttons
  'task-drawer-approval',
  'task-drawer-buttons',
  // Permission, sandbox and password screens
  'rules-card',
  'team-permissions',
  'team-coding-permission',
  'coding-reach',
  'coding-acknowledge',
  'coding-add-context',
  'coding-add-commit',
  'terminal-auth',
  'admin-password',
  'guard-form',
  'security-password',
  // Agent identity and error toasts
  'agent-glyph',
  'pet-avatar',
  'room-stage',
  'chat-toast',
  // The way back
  'command-run',
  'command-palette',
  'command-trigger',
  'menu-trigger',
  'user-way-back',
  'cz-back',
  'cz-error-back',
  'user-way-link',
  'user-menu-button',
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
