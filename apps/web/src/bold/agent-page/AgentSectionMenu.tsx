import { useEffect, useState } from 'react'
import { sectionsFor, scrollToId } from './agent-sections.ts'

/**
 * The section menu (mock-up 26): a sticky column on a desktop, a row of chips that scrolls sideways inside itself on
 * a phone. "Remove {agent}" closes it; the person confirms in the Remove panel, so this only opens it.
 */
export function AgentSectionMenu({
  coding,
  name,
  canRemove,
  removing,
  onRemove,
}: {
  coding: boolean
  name: string
  canRemove: boolean
  removing: boolean
  onRemove: () => void
}) {
  const sections = sectionsFor(coding)
  const [current, setCurrent] = useState<string>(sections[0]!.id)
  // Follows the scroll where the browser can tell us (jsdom has no IntersectionObserver).
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const seen = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) seen.add(entry.target.id)
          else seen.delete(entry.target.id)
        }
        const first = sections.find((section) => seen.has(section.id))
        if (first) setCurrent(first.id)
      },
      { rootMargin: '-10% 0px -60% 0px' },
    )
    for (const section of sections) {
      const element = document.getElementById(section.id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [sections])
  return (
    <nav className="bold-agent-menu" aria-label="Sections">
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={current === section.id ? 'true' : undefined}
          onClick={(event) => {
            event.preventDefault()
            setCurrent(section.id)
            scrollToId(section.id)
          }}
        >
          {section.label}
        </a>
      ))}
      {canRemove && (
        <>
          <span className="bold-agent-menu-rule" aria-hidden />
          <button
            type="button"
            className="bold-agent-menu-remove"
            id="agent-remove-open"
            aria-expanded={removing}
            onClick={onRemove}
          >
            Remove {name}
          </button>
        </>
      )}
    </nav>
  )
}
