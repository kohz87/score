import { ORCH_ACKNOWLEDGEMENT_TEXT, ScheduleTextSchema, type RecipeSchedule } from '@score/contract'
import { useId, useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { useRecipeChats } from './use-recipe-chats.ts'
import { useRecipeScheduleActions, useScheduleBinding } from './recipe-schedule-queries.ts'
import {
  browserTimeZone,
  draftFromSchedule,
  PRESETS,
  scheduleFromDraft,
  WEEKDAYS,
  type SchedulePreset,
} from './recipe-schedule-words.ts'

/**
 * Setting or changing a recipe's schedule (decision 183, mock-up 28-tasks-edit): when (the presets, a time, or a custom
 * schedule) and the chat each run starts in. The browser's own time zone is sent with it.
 */
export function RepeatsEditor({
  workflowId,
  schedule,
  onDone,
}: {
  workflowId: string
  schedule: RecipeSchedule | null
  onDone: () => void
}) {
  const ids = useId()
  const chats = useRecipeChats()
  const { save } = useRecipeScheduleActions(workflowId)
  // Each run is bound to the agents shown now and to the acknowledgement, as when starting a run (decision 183).
  const binding = useScheduleBinding(workflowId)
  const [ack, setAck] = useState(false)
  const [draft, setDraft] = useState(() => draftFromSchedule(schedule?.schedule ?? null))
  const [roomId, setRoomId] = useState(schedule?.roomId ?? '')
  const text = scheduleFromDraft(draft)
  const valid = ScheduleTextSchema.safeParse(text).success
  const known = chats.some((chat) => chat.id === roomId)
  const patch = (change: Partial<typeof draft>) => setDraft({ ...draft, ...change })
  const problem =
    save.error instanceof ApiError
      ? save.error.message
      : save.error
        ? 'Couldn’t save the schedule. Try again.'
        : null

  return (
    <form
      className="bold-rs-form"
      aria-label="Repeat this recipe"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid || !roomId) return
        if (!binding.agentMap || !ack) return
        save.mutate(
          {
            schedule: text,
            timezone: browserTimeZone(),
            roomId,
            // Resuming from the editor turns it on again: the person saw the agents and the acknowledgement here.
            enabled: true,
            agentMap: binding.agentMap,
            acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
          },
          { onSuccess: onDone },
        )
      }}
    >
      <label className="bold-rs-field" htmlFor={`${ids}-when`}>
        <span>Repeat</span>
        <select
          id={`${ids}-when`}
          className="field"
          value={draft.preset}
          onChange={(event) => patch({ preset: event.target.value as SchedulePreset })}
        >
          {PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      {draft.preset === 'week' && (
        <label className="bold-rs-field" htmlFor={`${ids}-day`}>
          <span>On</span>
          <select
            id={`${ids}-day`}
            className="field"
            value={draft.weekday}
            onChange={(event) => patch({ weekday: Number(event.target.value) })}
          >
            {WEEKDAYS.map((name, day) => (
              <option key={name} value={day}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft.preset === 'month' && (
        <label className="bold-rs-field" htmlFor={`${ids}-date`}>
          <span>On day</span>
          <input
            id={`${ids}-date`}
            className="field"
            type="number"
            min={1}
            max={31}
            value={draft.monthDay}
            onChange={(event) =>
              patch({ monthDay: Math.min(31, Math.max(1, Number(event.target.value) || 1)) })
            }
          />
        </label>
      )}
      {draft.preset === 'custom' ? (
        <label className="bold-rs-field" htmlFor={`${ids}-custom`}>
          <span>Schedule</span>
          <input
            id={`${ids}-custom`}
            className="field"
            value={draft.custom}
            placeholder="0 8 * * 1-5, or every 2h"
            aria-invalid={draft.custom.trim() !== '' && !valid ? true : undefined}
            onChange={(event) => patch({ custom: event.target.value })}
          />
          <small className="muted">
            A cron expression (minute hour day month weekday) or “every 2h”.
          </small>
        </label>
      ) : (
        <label className="bold-rs-field" htmlFor={`${ids}-time`}>
          <span>At</span>
          <input
            id={`${ids}-time`}
            className="field"
            type="time"
            value={draft.time}
            onChange={(event) => patch({ time: event.target.value || '08:00' })}
          />
        </label>
      )}
      <label className="bold-rs-field" htmlFor={`${ids}-chat`}>
        <span>Each run starts a job in</span>
        <select
          id={`${ids}-chat`}
          className="field"
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
        >
          <option value="">Choose a chat…</option>
          {roomId && !known && schedule && <option value={roomId}>{schedule.roomName}</option>}
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.name}
            </option>
          ))}
        </select>
      </label>
      <label className="orch-check orch-ack" data-protected="any">
        <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
        <span>{ORCH_ACKNOWLEDGEMENT_TEXT}</span>
      </label>
      {!binding.checking && !binding.agentMap && (
        <p role="alert" className="bold-error">
          Couldn’t check this recipe’s agents. Try again in a moment.
        </p>
      )}
      {problem && (
        <p role="alert" className="bold-error">
          {problem}
        </p>
      )}
      <div className="bold-rs-actions">
        <button
          type="submit"
          className="btn sm primary"
          disabled={!valid || !roomId || !ack || !binding.agentMap || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save schedule'}
        </button>
        <button type="button" className="btn sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
