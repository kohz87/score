import type { Room } from '@score/contract'
import { baseName } from './room-groups.ts'

/** "#launch" for a room named "#launch #q4": tag words are shown as chips, not in the title. */
export function roomLabel(room: Room) {
  const name = room.kind === 'room' ? baseName(room.name) : room.name
  return room.kind === 'room' && !name.startsWith('#') ? `#${name}` : name
}
