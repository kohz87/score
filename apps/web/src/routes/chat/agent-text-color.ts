const palette: Record<string, string> = {
  '#6B4EFF': 'var(--agent-violet-text)',
  '#19C39A': 'var(--agent-jade-text)',
  '#FFB61E': 'var(--agent-saffron-text)',
  '#FF6B8A': 'var(--agent-coral-text)',
}

export function agentTextColor(color: string) {
  return palette[color.toUpperCase()] ?? `color-mix(in srgb, ${color} 35%, var(--ink))`
}
