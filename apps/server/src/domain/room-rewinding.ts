/**
 * Rooms whose agents' Hermes sessions are being rewound right now. In memory on purpose (cleared by a restart: the
 * rewind request that set it is gone too). A new turn must not start in such a room, or it would run in the session
 * while Hermes undoes turns in it.
 */
export const rewindingRooms = new Set<string>()
