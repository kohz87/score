import type { MessagePageData } from '../../routes/chat/queries.ts'
import { useEffect, useMemo } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomChatMessagesQuery, roomSeekQuery } from './room-queries.ts'

export type PageState = {
  data?: MessagePageData & { found?: boolean }
  status: 'pending' | 'success' | 'error'
  error?: unknown
}

export function pageKey(before: string | null) {
  return before ?? 'latest'
}

export function seekMarker(seek: string) {
  return `seek:${seek}`
}

/** Registers one page of the chat's one chain (every topic together) and hands its state to the stream. */
export function MessagePageCollector({
  roomId,
  before,
  defaultJobId,
  onPage,
}: {
  roomId: string
  before: string | null
  defaultJobId: string | null
  onPage: (key: string, state: PageState) => void
}) {
  const definition = useMemo(
    () => roomChatMessagesQuery(roomId, before, defaultJobId),
    [before, defaultJobId, roomId],
  )
  const { data, status, error } = useStreamQuery(definition)
  useEffect(() => {
    onPage(pageKey(before), { data, status, error })
  }, [before, data, error, onPage, status])
  return null
}

/** Reads back through the chat's history to a `?message=` target without paging state. */
export function MessageSeekCollector({
  roomId,
  seek,
  onPage,
}: {
  roomId: string
  seek: string
  onPage: (key: string, state: PageState) => void
}) {
  const definition = useMemo(() => roomSeekQuery(roomId, null, seek, true), [roomId, seek])
  const { data, status, error } = useStreamQuery(definition)
  useEffect(() => {
    onPage(pageKey(seekMarker(seek)), { data, status, error })
  }, [data, error, onPage, seek, status])
  return null
}
