import type { Room, RoomProject } from '@score/contract'

export type RoomGroups = {
  pinned: Room[]
  projects: { project: RoomProject; rooms: Room[] }[]
  rest: Room[]
  /** Archived rooms hidden by the current view. */
  archivedHidden: number
  /** Every tag on the rooms that are currently in view (before the tag filter), sorted. */
  tags: string[]
}

const byName = (a: Room, b: Room) => a.name.localeCompare(b.name)

/**
 * The Rooms list (PLAN 5.26): pinned first, then one group per project, then the rest. Archived rooms are left out
 * unless asked for; a tag filter narrows every group.
 */
export function groupRooms(
  rooms: readonly Room[],
  projects: readonly RoomProject[],
  options: { showArchived: boolean; tag: string | null },
): RoomGroups {
  const visible = rooms.filter((room) => options.showArchived || !room.archived)
  const tags = [...new Set(visible.flatMap((room) => room.tags ?? []))].sort()
  const shown = visible
    .filter((room) => options.tag === null || (room.tags ?? []).includes(options.tag))
    .sort(byName)
  const known = new Set(projects.map((project) => project.id))
  const pinned = shown.filter((room) => room.pinned)
  const unpinned = shown.filter((room) => !room.pinned)
  return {
    pinned,
    projects: projects
      .map((project) => ({
        project,
        rooms: unpinned.filter((room) => room.projectId === project.id),
      }))
      .filter((group) => group.rooms.length > 0 || options.tag === null),
    rest: unpinned.filter((room) => !room.projectId || !known.has(room.projectId)),
    archivedHidden: options.showArchived ? 0 : rooms.filter((room) => room.archived).length,
    tags,
  }
}

/** The room's name without its `#tag` words, for display. */
export function baseName(name: string): string {
  return name.split(/\s+/)[0] ?? name
}
