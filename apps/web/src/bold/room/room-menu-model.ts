import type { Room } from '@score/contract'

export function isOlderRoom(room: Room): boolean {
  return room.role !== 'team' && room.kind === 'room' && !room.importedFrom
}
