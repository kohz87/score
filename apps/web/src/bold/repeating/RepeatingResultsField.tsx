import { Choices, Field } from './RepeatingFields.tsx'
import type { Deliver } from './repeating-form.ts'

// Tasks › Repeating (TR.2): Results go to: the agent's direct chat, a chat picked from the list, or nowhere (the run
// stays in the agent's runs).

export function ResultsField({
  agentName,
  rooms,
  deliver,
  roomId,
  onDeliver,
  onRoom,
}: {
  agentName: string
  rooms: readonly { id: string; name: string }[]
  deliver: Deliver
  roomId: string
  onDeliver: (deliver: Deliver) => void
  onRoom: (roomId: string) => void
}) {
  return (
    <Field label="Results go to">
      <Choices
        label="Results go to"
        value={deliver}
        options={[
          { id: 'direct', label: `${agentName} (direct)` },
          { id: 'chat', label: 'A chat…' },
          { id: 'none', label: 'Nowhere, just the run' },
        ]}
        onPick={onDeliver}
      />
      {deliver === 'chat' && (
        <select
          aria-label="Chat for the results"
          value={roomId}
          onChange={(event) => onRoom(event.target.value)}
        >
          <option value="">Pick a chat…</option>
          {rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}
