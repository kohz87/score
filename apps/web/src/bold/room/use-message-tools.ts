import type { RoomVersion } from '@score/contract'
import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { versionsQuery } from '../../routes/chat/queries.ts'
import { roomPinsQuery, setRoomPin } from './room-queries.ts'

/** What every place that draws messages with `BoldMessage` shares: the room's pins and its message versions. */
export function useMessageTools(roomId: string) {
  const pinsDefinition = useMemo(() => roomPinsQuery(roomId), [roomId])
  const pins = useStreamQuery(pinsDefinition)
  const refetchPins = useStreamQueryRefetch(pinsDefinition)
  const [pinOverrides, setPinOverrides] = useState<Record<string, boolean>>({})
  const [pinBusy, setPinBusy] = useState<string | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)
  const versionsDefinition = useMemo(() => versionsQuery(roomId), [roomId])
  const versions: RoomVersion[] = useStreamQuery(versionsDefinition).data ?? []
  const pinnedIds = useMemo(
    () => new Set((pins.data?.items ?? []).map((pin) => pin.messageId)),
    [pins.data],
  )
  const pinsRevision = pins.data?.revision ?? 0

  useEffect(() => {
    if (pinsRevision > 0) void refetchPins()
  }, [pinsRevision, refetchPins])

  function isPinned(messageId: string) {
    return pinOverrides[messageId] ?? pinnedIds.has(messageId)
  }

  async function togglePin(messageId: string) {
    const next = !isPinned(messageId)
    setPinBusy(messageId)
    setPinError(null)
    try {
      await setRoomPin(roomId, messageId, next)
      setPinOverrides((current) => ({ ...current, [messageId]: next }))
      void refetchPins()
    } catch (failure) {
      setPinError(
        failure instanceof ApiError ? failure.message : 'Couldn’t change the pin. Try again.',
      )
    } finally {
      setPinBusy(null)
    }
  }

  return { versions, isPinned, pinBusy, pinError, togglePin }
}
