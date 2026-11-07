import { useRef, type KeyboardEvent } from 'react'

const tabs = [
  { id: 'theme', label: 'Theme' },
  { id: 'colours', label: 'Colours' },
  { id: 'background', label: 'Background' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'shape', label: 'Shape' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'css', label: 'Custom CSS' },
] as const
export type TabId = (typeof tabs)[number]['id']

export function Tabs({ value, onChange }: { value: TabId; onChange: (id: TabId) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  function onKeyDown(event: KeyboardEvent, index: number) {
    const last = tabs.length - 1
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1
    if (next < 0) return
    event.preventDefault()
    onChange(tabs[next]!.id)
    refs.current[next]?.focus()
  }
  return (
    <div className="cz-tabs" role="tablist" aria-label="Sections">
      {tabs.map((item, index) => (
        <button
          key={item.id}
          ref={(element) => {
            refs.current[index] = element
          }}
          type="button"
          role="tab"
          id={`cz-tab-${item.id}`}
          aria-selected={value === item.id}
          aria-controls={`cz-panel-${item.id}`}
          tabIndex={value === item.id ? 0 : -1}
          className="cz-tab"
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
