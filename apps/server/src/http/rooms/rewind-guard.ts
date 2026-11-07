import { rewindingRooms } from '../../domain/room-rewinding.ts'
import { HttpError } from '../../errors.ts'

export const rewinding = rewindingRooms

export function assertNotRewinding(roomId: string) {
  if (rewinding.has(roomId))
    throw new HttpError(409, 'conflict', 'This room is being rewound. Try again in a moment.')
}
