import { useEffect, useRef, useState, type RefObject } from 'react'
import type { BotInputEvent } from '@score/contract'
import { clock } from '../security-lock.ts'
import { press, SHORTCUTS, textToEvents } from './keysyms.ts'
import { IDLE_SECONDS } from './use-control-session.ts'

/** The line under the screen while in control: the idle countdown, Type text…, the shortcut menu, Keyboard, Full screen. */
export function ControlBar({
  agentName,
  boxRef,
  lastInputAt,
  push,
}: {
  agentName: string
  boxRef: RefObject<HTMLDivElement | null>
  lastInputAt: { current: number }
  push: (...events: BotInputEvent[]) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [typing, setTyping] = useState(false)
  const [menu, setMenu] = useState(false)
  const [text, setText] = useState('')
  const keyboard = useRef<HTMLInputElement>(null)
  // The text the last composition sent, so Safari's trailing input event doesn't send it twice.
  const composed = useRef<string | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const left = Math.max(0, IDLE_SECONDS - (now - (lastInputAt.current || now)) / 1000)

  return (
    <div className="bold-to-bar" data-protected="flex">
      <span>
        Click the screen to type into it. Hands back to {agentName} in{' '}
        <strong className="bold-to-clock">{clock(left)}</strong> without input.
      </span>
      <span className="bold-to-spacer" />
      <button type="button" className="bold-to-tool" onClick={() => keyboard.current?.focus()}>
        Keyboard
      </button>
      <button
        type="button"
        className="bold-to-tool"
        aria-expanded={typing}
        onClick={() => setTyping((open) => !open)}
      >
        Type text…
      </button>
      <span className="bold-to-menu">
        <button
          type="button"
          className="bold-to-tool"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((open) => !open)}
        >
          Ctrl+Alt+…
        </button>
        {menu && (
          <span className="bold-to-menu-list" role="menu">
            {SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  push(...shortcut.events)
                  setMenu(false)
                  boxRef.current?.focus()
                }}
              >
                {shortcut.label}
              </button>
            ))}
          </span>
        )}
      </span>
      <button
        type="button"
        className="bold-to-tool"
        onClick={() => void boxRef.current?.requestFullscreen?.().catch(() => undefined)}
      >
        Full screen
      </button>
      {typing && (
        <form
          className="bold-to-type"
          onSubmit={(event) => {
            event.preventDefault()
            const typed = text
            setText('')
            if (typed) push(...textToEvents(typed))
            boxRef.current?.focus()
          }}
        >
          <label>
            <span className="bold-to-sr">Text to type on {agentName}’s desktop</span>
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button type="submit" className="bold-to-tool" disabled={text === ''}>
            Send
          </button>
        </form>
      )}
      {/* The phone's keyboard: a visually hidden field whose input is sent as key presses. */}
      <input
        ref={keyboard}
        className="bold-to-sr"
        type="text"
        aria-label="Keyboard input for the screen"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value=""
        onChange={() => undefined}
        onInput={(event) => {
          const native = event.nativeEvent as InputEvent
          // Composition (IME, swipe keyboards) is sent once, when it ends, not as every intermediate guess. Safari fires
          // compositionend before the composition's last input event, which then carries the same text again.
          if (
            native.isComposing ||
            native.inputType === 'insertCompositionText' ||
            native.inputType === 'insertFromComposition'
          )
            return
          if (composed.current !== null && native.data === composed.current) {
            composed.current = null
            return
          }
          composed.current = null
          if (native.inputType === 'deleteContentBackward') push(...press(0xff08))
          else if (native.data) push(...textToEvents(native.data))
        }}
        onCompositionEnd={(event) => {
          if (event.data) push(...textToEvents(event.data))
          composed.current = event.data || null
          // Safari's trailing input event comes in the same task; anything later is new typing, never swallowed.
          setTimeout(() => {
            composed.current = null
          }, 0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') push(...press(0xff0d))
          else if (event.key === 'Backspace') push(...press(0xff08))
        }}
      />
    </div>
  )
}
