import type { Room } from '@score/contract'

export function roomLabel(room: Room) {
  return room.kind === 'room' && !room.name.startsWith('#') ? `#${room.name}` : room.name
}
