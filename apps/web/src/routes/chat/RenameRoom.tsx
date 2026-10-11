import type { Room } from '@score/contract'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError } from '../../data/api.ts'
import { patchRoom } from './conversation-api.ts'
import { roomNameProblem } from './room-actions.ts'

/** Inline rename (PLAN 5.36): Enter saves, Escape cancels. The new name arrives on the stream as `room.upserted`. */
export function RenameRoom({
  room,
  onDone,
  onCancel,
  className,
}: {
  room: Room
  onDone: () => void
  onCancel: () => void
  className?: string | undefined
}) {
  const [text, setText] = useState(room.name)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  async function save() {
    const problem = roomNameProblem(text)
    if (problem) return setError(problem)
    const name = text.trim()
    if (name === room.name || `#${name}` === room.name) return onDone()
    setSaving(true)
    setError(null)
    try {
      await patchRoom(room.id, { name })
      onDone()
    } catch (failure) {
      setSaving(false)
      setError(
        failure instanceof ApiError && failure.status === 409
          ? 'Another room already has that name.'
          : 'Couldn’t rename the room. Try again.',
      )
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }
  return (
    <div className={`chat-rename ${className ?? ''}`}>
      <input
        ref={input}
        value={text}
        maxLength={200}
        aria-label="Room name"
        aria-invalid={error !== null}
        disabled={saving}
        onChange={(event) => {
          setText(event.target.value)
          setError(null)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!saving && !error) onCancel()
        }}
      />
      {error && (
        <p role="alert" className="chat-rename-error">
          {error}
        </p>
      )}
    </div>
  )
}
