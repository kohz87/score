import './unattributed-glyph.css'

/**
 * The glyph of work with no known agent (Kanban attempts whose claiming profile is unknown). It is deliberately not
 * one of the agent shapes: a dashed neutral tile with a question mark, so it can never be mistaken for an agent and
 * never relies on color alone.
 */
export function UnattributedGlyph({
  size = 'lg',
  decorative = false,
}: {
  size?: 'xs' | 'sm' | 'md' | 'lg'
  decorative?: boolean
}) {
  const accessibility = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': 'Unknown agent' }
  return (
    <span {...accessibility} className={`unattributed-glyph unattributed-glyph--${size}`}>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
        <path
          d="M7.6 7.7 A2.5 2.5 0 1 1 11 10 C10.3 10.4 10 10.8 10 11.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <circle cx="10" cy="14.6" r="1.1" fill="currentColor" />
      </svg>
    </span>
  )
}
