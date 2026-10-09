import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { redact } from '../redact.ts'
import { messageFromRow, roomRow } from './rooms.ts'

export interface ExportedMessage {
  id: string
  author: { kind: 'you' } | { kind: 'agent'; agentId: string; name: string }
  at: string
  text: string
  files: { path: string; added: number; removed: number }[]
  images: { mediaId: string }[]
}
export interface RoomExport {
  room: {
    id: string
    name: string
    kind: 'room' | 'direct'
    members: { id: string; name: string }[]
  }
  exportedAt: string
  messages: ExportedMessage[]
}

/**
 * Everything a person can read in the room, as plain data: text parts, file and image references (no media bytes),
 * redacted; deleted and still-streaming messages left out. Tool, thinking, plan, review and approval parts are not text.
 */
export function buildRoomExport(
  sqlite: DatabaseSync,
  roomId: string,
  names: ReadonlyMap<string, string>,
  exportedAt: string,
): RoomExport {
  const row = roomRow(sqlite, roomId)
  const nameOf = (id: string) => names.get(id) ?? id
  const members = z.array(z.string()).parse(JSON.parse(row.members))
  const messages = sqlite
    .prepare(
      'SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND streaming = 0 ORDER BY created_at, id',
    )
    .all(roomId)
    .map(messageFromRow)
    .map((message): ExportedMessage => {
      const text = message.parts.flatMap((part) =>
        part.kind === 'text' ? [redact(part.text)] : [],
      )
      return {
        id: message.id,
        author:
          message.author.kind === 'you'
            ? { kind: 'you' }
            : {
                kind: 'agent',
                agentId: message.author.agentId,
                name: nameOf(message.author.agentId),
              },
        at: message.createdAt,
        text: text.join('\n\n'),
        files: message.parts.flatMap((part) =>
          part.kind === 'file'
            ? [{ path: redact(part.path), added: part.added, removed: part.removed }]
            : [],
        ),
        images: message.parts.flatMap((part) =>
          part.kind === 'image' ? [{ mediaId: part.mediaId }] : [],
        ),
      }
    })
    .filter((message) => message.text || message.files.length || message.images.length)
  return {
    room: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      members: members.map((id) => ({ id, name: nameOf(id) })),
    },
    exportedAt,
    messages,
  }
}

export function roomExportMarkdown(data: RoomExport): string {
  const lines = [
    `# ${data.room.name}`,
    '',
    `- Members: ${data.room.members.map((member) => member.name).join(', ') || 'none'}`,
    `- Exported at: ${data.exportedAt}`,
    '',
  ]
  for (const message of data.messages) {
    lines.push(
      '---',
      '',
      `**${message.author.kind === 'you' ? 'You' : message.author.name}** · ${message.at}`,
      '',
    )
    if (message.text) lines.push(message.text, '')
    for (const file of message.files)
      lines.push(`- File: \`${file.path}\` (+${file.added} −${file.removed})`)
    for (const image of message.images) lines.push(`- Image: ${image.mediaId}`)
    if (message.files.length || message.images.length) lines.push('')
  }
  return lines.join('\n')
}
