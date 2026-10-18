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
  // Needs-you markers
  'needs-you-dot',
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
  'terminal-auth',
  'admin-password',
  'guard-form',
  'security-password',
  // Agent identity and error toasts
  'agent-glyph',
  'chat-toast',
  // The way back
  'command-run',
  'command-palette',
  'command-trigger',
  'menu-trigger',
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
