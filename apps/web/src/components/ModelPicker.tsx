import { ModelsResponseSchema, type ModelOption } from '@score/contract'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { apiFetch } from '../data/api.ts'
import './model-picker.css'

export interface ModelChoice {
  model: string
  /** Provider id, or null for a typed name Score can't match to a provider (custom or local models). */
  provider: string | null
}

export function formatPrice(option: ModelOption): string {
  if (option.free) return 'Free'
  return option.price ? `${option.price.input} / ${option.price.output} per 1M` : 'Price unknown'
}

interface Props {
  label: string
  value: ModelChoice
  onChange: (choice: ModelChoice) => void
  required?: boolean
  maxLength?: number
}

export function ModelPicker({ label, value, onChange, required, maxLength = 256 }: Props) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState<{ list: ModelOption[]; at: number } | null>(null)
  const [query, setQuery] = useState(value.model)
  const [providerLabel, setProviderLabel] = useState<string | null>(null)
  const [typed, setTyped] = useState(false)

  // Only what the person typed filters the list; picking a value must not narrow it to that one row.
  useEffect(() => {
    if (!typed) return
    const timer = setTimeout(() => setQuery(value.model), 150)
    return () => clearTimeout(timer)
  }, [typed, value.model])

  const models = useQuery({
    queryKey: ['models', query.trim()],
    queryFn: async () =>
      ModelsResponseSchema.parse(
        await apiFetch(`models${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`),
      ).items,
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
  const items = useMemo(() => models.data ?? [], [models.data])
  const groups = useMemo(() => {
    const byProvider = new Map<
      string,
      { label: string; rows: { option: ModelOption; at: number }[] }
    >()
    items.forEach((option, at) => {
      const group = byProvider.get(option.provider) ?? { label: option.providerLabel, rows: [] }
      group.rows.push({ option, at })
      byProvider.set(option.provider, group)
    })
    return [...byProvider.entries()]
  }, [items])

  // The highlight belongs to one list; a new list starts with none.
  const active = cursor && cursor.list === items ? cursor.at : -1
  const setActive = (at: number) => setCursor({ list: items, at })

  function pick(option: ModelOption) {
    if (!option.available) return
    setTyped(false)
    setQuery(option.model)
    setProviderLabel(option.providerLabel)
    onChange({ model: option.model, provider: option.provider })
    setOpen(false)
  }
  // While the list still answers an older query, arrows and Enter must not act on it.
  const settled = !models.isPlaceholderData && (!typed || query === value.model)
  function step(direction: 1 | -1) {
    if (!settled || !items.some((option) => option.available)) return
    let next = active
    do next = (next + direction + items.length) % items.length
    while (!items[next]!.available)
    setActive(next)
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) setOpen(true)
      else step(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const option = settled ? items[active] : undefined
      if (option) pick(option)
      else setOpen(false) // free text stays as typed
    } else if (event.key === 'Escape' && open) {
      // Close the list without also closing a surrounding dialog.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  const selected = items.find((o) => o.provider === value.provider && o.model === value.model)
  const providerName =
    value.provider === null ? null : (providerLabel ?? selected?.providerLabel ?? value.provider)
  const note = models.isError
    ? 'Models could not be loaded. You can still type a model name.'
    : models.isPending
      ? 'Loading models…'
      : items.length
        ? null
        : query.trim()
          ? 'No matching models. Press Enter to use the name as typed.'
          : 'No connected models found. You can type a model name.'

  return (
    <div className="model-picker">
      <label htmlFor={id}>{label}</label>
      <div className="model-picker-field">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          required={required}
          maxLength={maxLength}
          value={value.model}
          onChange={(event) => {
            setTyped(true)
            setProviderLabel(null)
            setOpen(true)
            onChange({ model: event.target.value, provider: null })
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {open && (
          <div className="model-picker-panel" data-note-only={!items.length || undefined}>
            <div
              id={listId}
              role="listbox"
              aria-label={`${label} suggestions`}
              className="model-picker-list"
              // Keep focus in the input while an option is pressed.
              onMouseDown={(event) => event.preventDefault()}
            >
              {groups.map(([provider, group]) => (
                <div
                  key={provider}
                  role="group"
                  aria-label={group.label}
                  className="model-picker-group"
                >
                  <div className="model-picker-heading" aria-hidden="true">
                    {group.label}
                  </div>
                  {group.rows.map(({ option, at }) => (
                    <div
                      key={option.model}
                      id={`${id}-opt-${at}`}
                      role="option"
                      aria-selected={active === at}
                      aria-disabled={!option.available || undefined}
                      className="model-picker-option"
                      data-active={active === at || undefined}
                      onClick={() => pick(option)}
                      onMouseMove={() => option.available && setActive(at)}
                    >
                      <span className="model-picker-model">{option.model}</span>
                      <span className="model-picker-meta">
                        {option.available ? formatPrice(option) : (option.reason ?? 'Unavailable')}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {note && <p className="model-picker-note">{note}</p>}
          </div>
        )}
      </div>
      {providerName && <p className="model-picker-via">Through {providerName}</p>}
      <p className="model-picker-sr" role="status" aria-live="polite">
        {open && items.length
          ? `${items.length} ${items.length === 1 ? 'model' : 'models'} available`
          : ''}
      </p>
    </div>
  )
}
