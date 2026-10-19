import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  SecurityStatusSchema,
  TerminalServerFrameSchema,
  TerminalTicketSchema,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { passkeysSupportedHere, signInWithPasskey } from '../../data/passkeys.ts'
import { KEY_BYTES, clipboardKey, osc52Text, withCtrl } from './keys.ts'
import { copyText, readClipboardText } from '../../data/clipboard.ts'
import './terminal.css'

type Phase = 'auth' | 'connecting' | 'open' | 'ended'

function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function authError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'wrong_password') return 'That is not the security password.'
  if (code === 'too_many_attempts') return 'Too many wrong passwords. Try again later.'
  if (code === 'password_not_set') return 'Set a security password in Settings first.'
  if (code === 'too_many_terminals') return 'Two terminals are already open. Close one in Settings.'
  if (code === 'second_factor_not_enrolled')
    return 'The terminal needs a security password set on the Score machine: run scripts/score password there (a password set in the browser does not unlock the terminal).'
  if (code === 'https_required')
    return 'The terminal only works over HTTPS (Score in remote mode with a certificate).'
  if (code === 'fresh_auth_required')
    return 'Confirm your password or passkey again, then open the terminal.'
  return 'Couldn’t open the terminal. Try again.'
}

const endings: Record<string, string> = {
  exited: 'The shell ended.',
  idle: 'Closed after 15 minutes without activity.',
  limit: 'Closed after the 8-hour limit.',
  closed: 'Closed.',
  revoked: 'Closed because this browser was signed out.',
  stalled: 'Closed because the connection stopped keeping up.',
  stopped: 'Closed because Score stopped.',
}

export function TerminalPage() {
  const security = useQuery({
    queryKey: ['session', 'security'],
    queryFn: async () => SecurityStatusSchema.parse(await apiFetch('session/security')),
  })
  const [phase, setPhase] = useState<Phase>('auth')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [user, setUser] = useState('')
  const [ending, setEnding] = useState('')
  const [ctrl, setCtrl] = useState(false)
  const [pasteHint, setPasteHint] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(0)
  /**
   * Copies the terminal's selection through the browser's own copy event, which xterm fills from its selection: no
   * Clipboard API permission is involved, so it works on a LAN address with a self-signed certificate, where
   * `navigator.clipboard` may be refused. The Clipboard API is only the fallback.
   */
  const showCopied = useCallback(() => {
    setCopied(true)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }, [])
  const copySelection = useCallback(
    (xterm: Terminal) => {
      if (!xterm.hasSelection()) return
      const text = xterm.getSelection()
      xterm.focus()
      let done: boolean
      try {
        // The only permission-free way to raise a copy event; xterm answers it with its selection.
        done = document.execCommand('copy')
      } catch {
        done = false
      }
      if (!done) void copyText(text)
      xterm.clearSelection()
      showCopied()
    },
    [showCopied],
  )
  /** Text a program in the terminal asked to copy (OSC 52, e.g. a tmux mouse selection); the copy event takes it. */
  const pendingCopy = useRef<string | null>(null)
  const copyFromProgram = useCallback(
    (xterm: Terminal, text: string) => {
      xterm.focus()
      pendingCopy.current = text
      let done: boolean
      try {
        done = document.execCommand('copy')
      } catch {
        done = false
      }
      if (pendingCopy.current !== null) done = false
      pendingCopy.current = null
      if (!done) void copyText(text)
      showCopied()
    },
    [showCopied],
  )
  /** When the person last pressed a key or released the mouse in the terminal (OSC 52 is honoured only just after). */
  const lastGesture = useRef(0)
  const host = useRef<HTMLDivElement>(null)
  const socket = useRef<WebSocket | null>(null)
  const term = useRef<Terminal | null>(null)
  const ctrlRef = useRef(false)

  useEffect(() => {
    ctrlRef.current = ctrl
  }, [ctrl])

  // Leaving the page (or a second effect run in development) invalidates everything still in flight.
  const alive = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      pending.current?.abort()
      socket.current?.close()
      socket.current = null
      term.current?.dispose()
      term.current = null
    }
  }, [])

  const send = useCallback((data: string) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(new TextEncoder().encode(data))
  }, [])

  const open = useCallback(
    (ticket: string) => {
      const parent = host.current
      if (!alive.current || !parent) return
      setPhase('connecting')
      const url = new URL('/api/terminal/ws', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('ticket', ticket)
      const xterm = new Terminal({
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 14,
        cursorBlink: true,
        theme: {
          background: token('--watch-window', '#0f1116'),
          foreground: token('--rules-text', '#d6d8de'),
          cursor: token('--rules-go', '#5ee3bf'),
          selectionBackground: token('--watch-window-dot', '#3a3e4a'),
        },
      })
      term.current = xterm
      const fit = new FitAddon()
      xterm.loadAddon(fit)
      // Anything that can throw runs before the socket exists, so a failed setup never leaves a terminal behind.
      xterm.open(parent)
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      socket.current = ws
      const tell = () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }))
      }
      const refit = () => {
        fit.fit()
        tell()
      }
      const observer = new ResizeObserver(refit)
      observer.observe(parent)
      // Copy and paste the way Windows Terminal does (see clipboardKey). A paste key is left to the browser, whose paste
      // event xterm turns into input; no clipboard permission is needed for it.
      xterm.attachCustomKeyEventHandler((event) => {
        const action = clipboardKey(event, xterm.hasSelection())
        if (action === 'copy') {
          if (event.type === 'keydown') copySelection(xterm)
          event.preventDefault()
          return false
        }
        return action !== 'paste'
      })
      // tmux (and vim, …) copy a mouse or keyboard selection by sending OSC 52 to the outer terminal. Honour it, but only
      // right after the person's own action in the terminal: a file or program printing the sequence on its own could
      // otherwise swap the clipboard for a command they would then paste. Reading the clipboard (a `?` query) never.
      for (const type of ['pointerup', 'keydown'] as const)
        parent.addEventListener(type, () => (lastGesture.current = performance.now()), {
          capture: true,
        })
      parent.addEventListener(
        'copy',
        (event) => {
          const text = pendingCopy.current
          if (text === null || !event.clipboardData) return
          event.clipboardData.setData('text/plain', text)
          event.preventDefault()
          event.stopImmediatePropagation()
          pendingCopy.current = null
        },
        { capture: true },
      )
      xterm.parser.registerOscHandler(52, (data) => {
        const text = osc52Text(data)
        if (text !== null && performance.now() - lastGesture.current < 3000)
          copyFromProgram(xterm, text)
        return true
      })
      // Right-click with text selected copies it, as in Windows Terminal (the browser's menu can't see the
      // terminal's own selection). Without a selection the browser's menu opens as usual.
      parent.addEventListener(
        'contextmenu',
        (event) => {
          if (!xterm.hasSelection()) return
          event.preventDefault()
          event.stopPropagation()
          copySelection(xterm)
        },
        { capture: true },
      )
      xterm.onData((data) => {
        send(ctrlRef.current ? withCtrl(data) : data)
        if (ctrlRef.current) setCtrl(false)
      })
      ws.onopen = () => {
        setPhase('open')
        refit()
        xterm.focus()
      }
      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (typeof event.data !== 'string') return xterm.write(new Uint8Array(event.data))
        const frame = TerminalServerFrameSchema.safeParse(JSON.parse(event.data))
        if (!frame.success) return
        if (frame.data.type === 'ready') setUser(frame.data.user)
        else setEnding(endings[frame.data.reason] ?? 'Closed.')
      }
      ws.onclose = () => {
        observer.disconnect()
        setPhase('ended')
        setEnding((current) => current || 'The connection closed.')
      }
    },
    [send, copySelection, copyFromProgram],
  )

  async function begin(proof: (signal: AbortSignal) => Promise<unknown>) {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setError('')
    setPhase('connecting')
    try {
      await proof(controller.signal)
      if (!alive.current || controller.signal.aborted) return
      const ticket = TerminalTicketSchema.parse(
        await apiFetch('terminal/tickets', { method: 'POST', signal: controller.signal }),
      ).ticket
      if (!alive.current || controller.signal.aborted) return
      setPassword('')
      open(ticket)
    } catch (caught) {
      if (!alive.current || controller.signal.aborted) return
      setError(authError(caught))
      setPhase('auth')
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void begin((signal) =>
      apiFetch('session/security/check', {
        signal,
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
    )
  }

  if (security.isSuccess && !security.data.terminal)
    return (
      <section className="terminal-page">
        <h1>Terminal</h1>
        <p role="status">
          The terminal is off. Start Score with <code>SCORE_TERMINAL=1</code> to turn it on.
        </p>
      </section>
    )

  const showTerminal = phase === 'open' || phase === 'ended'
  return (
    <section className="terminal-page">
      <h1>Terminal</h1>
      <p className="terminal-notice">
        This is a shell on the Score machine{user ? ` as ${user}` : ''}. Anyone who can use it can
        do anything that account can. Closed after 15 minutes without activity: use tmux for long
        jobs.
      </p>
      {phase === 'auth' && (
        <form
          className="terminal-auth"
          onSubmit={submit}
          aria-label="Confirm it’s you"
          data-protected="any"
        >
          <label>
            Security password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" className="terminal-primary" disabled={password.length < 8}>
            Open terminal
          </button>
          {passkeysSupportedHere() && (
            <button type="button" onClick={() => void begin(signInWithPasskey)}>
              Use a passkey
            </button>
          )}
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      {phase === 'connecting' && <p role="status">Opening…</p>}
      {phase === 'ended' && (
        <p role="status">
          {ending}{' '}
          <button
            type="button"
            onClick={() => {
              term.current?.dispose()
              term.current = null
              socket.current = null
              setEnding('')
              setUser('')
              setPhase('auth')
            }}
          >
            Open another
          </button>
        </p>
      )}
      <div
        ref={host}
        className="terminal-screen"
        data-testid="terminal-screen"
        hidden={!showTerminal}
      />
      {phase === 'open' && (
        <div className="terminal-keys" role="toolbar" aria-label="Terminal keys">
          {(Object.keys(KEY_BYTES) as (keyof typeof KEY_BYTES)[]).map((key) => (
            <button key={key} type="button" onClick={() => send(KEY_BYTES[key])}>
              {key}
            </button>
          ))}
          <button type="button" aria-pressed={ctrl} onClick={() => setCtrl((on) => !on)}>
            Ctrl
          </button>
          <button
            type="button"
            onClick={() => {
              if (term.current) copySelection(term.current)
            }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => {
              void readClipboardText().then((text) => {
                if (text) term.current?.paste(text)
                else setPasteHint(true)
                term.current?.focus()
              })
            }}
          >
            Paste
          </button>
          {copied && (
            <p className="terminal-paste-hint" role="status">
              Copied.
            </p>
          )}
          {pasteHint && (
            <p className="terminal-paste-hint" role="status">
              The browser didn’t share the clipboard. Press Ctrl+V (⌘V on a Mac) in the terminal
              instead.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
