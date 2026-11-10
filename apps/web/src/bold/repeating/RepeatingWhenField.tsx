import { useMemo } from 'react'
import { Choices, Field } from './RepeatingFields.tsx'
import type { RepeatingForm } from './repeating-form.ts'
import { WEEKDAY_NAMES, previewNext, zoneLabel, type ScheduleKind } from './schedule-words.ts'

const KINDS: { id: ScheduleKind; label: string }[] = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Every week' },
  { id: 'monthly', label: 'Every month' },
  { id: 'custom', label: 'Custom' },
]

export function WhenField({
  form,
  now,
  onChange,
}: {
  form: RepeatingForm
  now: Date
  onChange: (patch: Partial<RepeatingForm>) => void
}) {
  const zone = useMemo(() => zoneLabel(now), [now])
  const next = previewNext(form.kind, form.time, form.day, now)
  return (
    <Field label="When">
      <Choices
        label="When"
        value={form.kind}
        options={KINDS}
        onPick={(kind) => onChange({ kind })}
      />
      {form.kind === 'custom' ? (
        <span className="bold-rj-row">
          <input
            aria-label="Schedule"
            placeholder="0 8 * * 1-5, or every 2h"
            value={form.custom}
            onChange={(event) => onChange({ custom: event.target.value })}
          />
          <span className="bold-rj-hint">as typed · read in your time ({zone})</span>
        </span>
      ) : (
        <span className="bold-rj-row">
          {form.kind === 'weekly' && (
            <select
              aria-label="Day of the week"
              value={form.day}
              onChange={(event) => onChange({ day: Number(event.target.value) })}
            >
              {WEEKDAY_NAMES.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {form.kind === 'monthly' && (
            <select
              aria-label="Day of the month"
              value={form.day}
              onChange={(event) => onChange({ day: Number(event.target.value) })}
            >
              {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>
                  Day {day}
                </option>
              ))}
            </select>
          )}
          <input
            aria-label="Time"
            type="time"
            value={form.time}
            onChange={(event) => onChange({ time: event.target.value })}
          />
          <span className="bold-rj-hint">
            your time ({zone}){next ? ` · next: ${next}` : ''}
          </span>
        </span>
      )}
    </Field>
  )
}
