import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { SystemLine } from '../room/topic-divider.tsx'
import { newId } from '../../data/ids.ts'
import type { EffortSay } from './effort-command.ts'

/**
 * Lines a control outside the composer (the context bar, Chat info) puts in its chat, such as an effort's note with Undo.
 * The open chat listens and adds them to its stream; no other chat hears them.
 */
type Note = { roomId: string; text: string; action?: { label: string; run: () => void } }
const listeners = new Set<(note: Note) => void>()

export function sayInChat(roomId: string, text: string, action?: Note['action']): void {
  for (const listener of listeners) listener({ roomId, text, ...(action ? { action } : {}) })
}

/** A chat's `say`: adds a system line to its stream, with an optional action (Undo). */
export function chatSay(setLines: Dispatch<SetStateAction<SystemLine[]>>): EffortSay {
  return (text, action) =>
    setLines((lines) => [
      ...lines,
      { id: newId(), at: new Date().toISOString(), text, ...(action ? { action } : {}) },
    ])
}

/** Keeps the chat's `say` current for the notes addressed to it. */
export function useChatNotes(roomId: string, say: EffortSay): void {
  const latest = useRef(say)
  useEffect(() => {
    latest.current = say
  })
  useEffect(() => {
    const listener = (note: Note) => {
      if (note.roomId === roomId) latest.current(note.text, note.action)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [roomId])
}
