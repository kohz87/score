import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { ACCEPT, MAX_ATTACHMENTS } from './attachments.ts'
import type { Notice, TopicCommands } from './composer-types.ts'
import type { useVoiceInput } from './voice.ts'

export function ComposerAttachControls({
  roomMode,
  orchestrate,
  pending,
  attachmentCount,
  uploading,
  fileInput,
  upload,
  onPickWorkspace,
  voice,
  toggleVoice,
  edit,
  textarea,
  topicCommands,
  setNotice,
}: {
  roomMode: boolean
  orchestrate?: (goal: string) => void
  pending: boolean
  attachmentCount: number
  uploading: number
  fileInput: RefObject<HTMLInputElement | null>
  upload: (picked: File[]) => Promise<void>
  onPickWorkspace: () => void
  voice: ReturnType<typeof useVoiceInput>
  toggleVoice: () => void
  edit: (value: string, position: number) => void
  textarea: RefObject<HTMLTextAreaElement | null>
  topicCommands?: TopicCommands
  setNotice: Dispatch<SetStateAction<Notice | null>>
}) {
  const [attachMenu, setAttachMenu] = useState(false)
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        className="chat-sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept={ACCEPT}
        multiple
        data-testid="attach-input"
        onChange={(event) => void upload([...(event.target.files ?? [])])}
      />
      <span
        className="chat-attach-menu"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && attachMenu) {
            event.stopPropagation()
            setAttachMenu(false)
          }
        }}
      >
        <button
          type="button"
          className="chat-attach"
          aria-label={
            roomMode ? 'Attach, voice and commands' : orchestrate ? 'Add' : 'Attach files'
          }
          aria-haspopup="true"
          aria-expanded={attachMenu}
          title={
            orchestrate
              ? 'Attach files or start an orchestration'
              : 'Attach images and documents (up to 10; 25 MB each)'
          }
          disabled={pending || (!orchestrate && attachmentCount + uploading >= MAX_ATTACHMENTS)}
          onClick={() => setAttachMenu(!attachMenu)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            {orchestrate || roomMode ? (
              <path
                d="M8 3 V13 M3 8 H13"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M10.5 5 L5.8 9.7 A1.6 1.6 0 0 0 8.1 12 L13 7.1 A3 3 0 0 0 8.8 2.9 L3.9 7.8 A4.4 4.4 0 0 0 10.1 14"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            )}
          </svg>
        </button>
        {attachMenu && (
          <ul
            className="chat-attach-list"
            aria-label={roomMode ? 'Attach, voice and commands' : orchestrate ? 'Add' : 'Attach'}
          >
            <li>
              <button
                type="button"
                onClick={() => {
                  setAttachMenu(false)
                  fileInput.current?.click()
                }}
              >
                Upload files…
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setAttachMenu(false)
                  onPickWorkspace()
                }}
              >
                From workspace…
              </button>
            </li>
            {roomMode && voice.supported && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setAttachMenu(false)
                    toggleVoice()
                  }}
                >
                  {voice.listening ? 'Stop voice input' : 'Voice input'}
                </button>
              </li>
            )}
            {roomMode && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setAttachMenu(false)
                    edit('/', 1)
                    requestAnimationFrame(() => textarea.current?.focus())
                  }}
                >
                  Commands…
                </button>
              </li>
            )}
            {roomMode && topicCommands?.items.some((item) => item.name === 'run') && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setAttachMenu(false)
                    // The same dialog as /run: Start a run for this chat (3.24.0: the header's + Job is gone).
                    topicCommands.run('run', '').catch((error: unknown) =>
                      setNotice({
                        kind: 'error',
                        text:
                          error instanceof Error
                            ? error.message
                            : 'That command failed. Try again.',
                      }),
                    )
                  }}
                >
                  Start a run…
                </button>
              </li>
            )}
            {orchestrate && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setAttachMenu(false)
                    orchestrate('')
                  }}
                >
                  Start an orchestration…
                </button>
              </li>
            )}
          </ul>
        )}
      </span>
      {voice.supported && (
        <button
          type="button"
          className="chat-voice"
          aria-label="Voice input"
          aria-pressed={voice.listening}
          title={voice.listening ? 'Stop listening' : 'Dictate a message'}
          onClick={toggleVoice}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="5.5"
              y="1.5"
              width="5"
              height="8"
              rx="2.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M3 7.5 A5 5 0 0 0 13 7.5 M8 12.5 V14.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </>
  )
}
