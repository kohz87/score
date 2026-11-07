import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { sendsOnKey } from '../../data/send-key.ts'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { ComposerAttachControls } from './ComposerAttachControls.tsx'
import { ComposerAttachments } from './ComposerAttachments.tsx'
import { ComposerEditing } from './ComposerEditing.tsx'
import { ComposerMenu } from './ComposerMenu.tsx'
import { ComposerNotice } from './ComposerNotice.tsx'
import { ComposerSendControls } from './ComposerSendControls.tsx'
import { ComposerToPicker } from './ComposerToPicker.tsx'
import { attachmentKey } from './attachments.ts'
import { loadDraft, saveDraft } from './composer-model.ts'
import { createLocalCommandRunner } from './composer-local-command.ts'
import { useComposerSend } from './composer-send.ts'
import type { ComposerProps, Notice } from './composer-types.ts'
import { useComposerEditing } from './use-composer-editing.ts'
import { useComposerMenu } from './use-composer-menu.ts'
import { useComposerRoom } from './use-composer-room.ts'
import { useComposerUploads } from './use-composer-uploads.ts'
import { useComposerVoice } from './use-composer-voice.ts'

export function Composer({
  roomId,
  roomName,
  agents,
  offered = agents,
  leadAgentId = null,
  onSent,
  onCompress,
  orchestrate,
  jobId = null,
  roomMode = false,
  toLabel,
  placeholder,
  hold,
  messagesKey,
  initialText,
  references = [],
  draftScope,
  resolveJob,
  onClosedJob,
  topicCommands,
  footer,
}: ComposerProps) {
  const queryClient = useQueryClient()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const sendKey = useRef<{ signature: string; key: string } | null>(null)
  const ids = useId()
  const [text, setText] = useState(() => initialText ?? loadDraft(draftScope ?? roomId))
  const [caret, setCaret] = useState(0)
  const [to, setTo] = useState<string[]>([])
  const [planFirst, setPlanFirst] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const latestSend = useRef<(force?: boolean) => Promise<void>>(async () => {})
  const latest = useRef({ leaveEdit: () => {} })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [dragging, setDragging] = useState(false)

  const uploads = useComposerUploads({ draftText: text, setNotice })
  const {
    attachments,
    setAttachments,
    uploading,
    sendingFiles,
    saveTo,
    setSaveTo,
    knowledgeFlow,
    fileInput,
    live,
    upload,
    addWorkspaceFile,
    saveSentToKnowledge,
  } = uploads

  const {
    editing,
    editId,
    stash,
    setStash,
    editSession,
    rewoundEdit,
    rewindKey,
    rewinding,
    setRewinding,
    leaveEdit,
    markRewound,
    confirmEdit,
    setConfirmEdit,
    setLoadedEdit,
  } = useComposerEditing({
    roomId,
    text,
    to,
    attachments,
    setText,
    setCaret,
    setTo,
    setAttachments,
    setPlanFirst,
    setNotice,
    textarea,
  })
  useEffect(() => {
    latest.current = { leaveEdit }
  })

  const {
    roomMessagesKey,
    writing,
    stopping,
    stopReplies,
    subject,
    subjectAgent,
    finishedReplies,
    meterAgents,
    compactSignal,
    setCompactSignal,
    compactSubject,
    setCompactSubject,
  } = useComposerRoom({ roomId, messagesKey, agents, leadAgentId, to, setNotice })

  const { voice, toggleVoice } = useComposerVoice({ text, setText, setCaret, textarea })
  useEffect(() => {
    if (!editId) saveDraft(draftScope ?? roomId, text)
  }, [draftScope, roomId, text, editId])

  const {
    commands,
    slashItems,
    mentionItems,
    menu,
    count,
    index,
    optionId,
    edit,
    select,
    setActive,
    setClosed,
  } = useComposerMenu({
    text,
    caret,
    offered,
    orchestrate,
    topicCommands,
    ids,
    textarea,
    setText,
    setCaret,
  })

  // "From workspace…" browses the workspace of whoever the message goes to: the To chips, else the room lead.
  const pickerAgents = agents.filter((agent) =>
    to.length ? to.includes(agent.id) : agent.id === (leadAgentId ?? agents[0]?.id),
  )

  const runLocalCommand = createLocalCommandRunner({
    subject,
    subjectAgent,
    setText,
    setCaret,
    setNotice,
    onCompress,
    roomMode,
    hasFooter: Boolean(footer),
    setCompactSubject,
    setCompactSignal,
    queryClient,
  })
  const send = useComposerSend({
    roomId,
    roomMode,
    draftScope,
    jobId,
    hold,
    orchestrate,
    topicCommands,
    references,
    resolveJob,
    onSent,
    onClosedJob,
    text,
    editing,
    pending,
    uploading,
    attachments,
    to,
    planFirst,
    setText,
    setCaret,
    setTo,
    setAttachments,
    setPending,
    setRewinding,
    setNotice,
    setConfirmEdit,
    setLoadedEdit,
    setStash,
    stash,
    editSession,
    rewoundEdit,
    rewindKey,
    sendKey,
    roomMessagesKey,
    queryClient,
    commands: commands.data,
    runLocalCommand,
    saveSentToKnowledge,
    latest,
    latestSend,
    mounted,
    live,
    textarea,
  })
  useEffect(() => {
    latestSend.current = send
  })

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
    if (menu && count) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        select(index)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setClosed(true)
        return
      }
    }
    // Phones: Enter is a newline and the Send button sends. Desktop: the "Send with" setting decides.
    if (sendsOnKey(event)) {
      event.preventDefault()
      void send()
    }
  }

  const lines = roomMode ? 1 : Math.min(Math.max(text.split('\n').length, 1), 8)
  // The room composer grows with what wraps, not only with newlines; CSS caps it at 8 lines and then scrolls.
  useLayoutEffect(() => {
    const box = textarea.current
    if (!roomMode || !box) return
    box.style.height = 'auto'
    if (box.scrollHeight > 0) box.style.height = `${box.scrollHeight}px`
  }, [roomMode, text])
  const roomToLabel = to.length
    ? `To: ${to.map((id) => `@${id}`).join(', ')}`
    : (toLabel ?? 'To: new job')
  return (
    <div className="chat-composer">
      <ComposerNotice notice={notice} pending={pending} />
      <ComposerMenu
        menu={menu}
        count={count}
        slashItems={slashItems}
        mentionItems={mentionItems}
        ids={ids}
        index={index}
        optionId={optionId}
        select={select}
      />
      <ComposerEditing
        editing={editing}
        confirmEdit={confirmEdit}
        roomId={roomId}
        roomMode={roomMode}
        agents={agents}
        rewinding={rewinding}
        onClose={() => setConfirmEdit(false)}
        onDone={(messageId) => {
          markRewound(messageId)
          setConfirmEdit(false)
          void send()
        }}
        onCancel={leaveEdit}
      />
      {pickingWorkspace && (
        <WorkspacePicker
          agents={pickerAgents}
          onPick={addWorkspaceFile}
          onClose={() => setPickingWorkspace(false)}
        />
      )}
      <form
        className={`chat-composer-box${roomMode ? ' chat-composer-box--room' : ''}${dragging ? ' chat-dropzone' : ''}`}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(event) => {
          setDragging(false)
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          void upload([...event.dataTransfer.files])
        }}
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <label className="chat-sr-only" htmlFor={`${ids}-text`}>
          Message {roomName}
        </label>
        {roomMode && !footer && (
          <span className="chat-composer-room-to" title={roomToLabel}>
            {roomToLabel}
          </span>
        )}
        <textarea
          id={`${ids}-text`}
          ref={textarea}
          rows={lines}
          value={text}
          aria-describedby={roomMode && !footer ? `${ids}-hint` : undefined}
          disabled={Boolean(hold)}
          placeholder={hold ?? placeholder ?? (roomMode ? 'Message the team…' : 'Write a message…')}
          role="combobox"
          aria-expanded={menu !== null && count > 0}
          aria-controls={`${ids}-menu`}
          aria-autocomplete="list"
          aria-activedescendant={menu && count ? optionId(index) : undefined}
          onChange={(event) => edit(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // Pasted files (a screenshot, a copied document) attach; pasted text is left alone.
            const files = [...event.clipboardData.files]
            if (!files.length) return
            event.preventDefault()
            void upload(files)
          }}
        />
        <ComposerAttachments
          attachments={attachments}
          uploading={uploading}
          sendingFiles={sendingFiles}
          saveTo={saveTo}
          setSaveTo={setSaveTo}
          onRemove={(item) =>
            setAttachments(
              attachments.filter((other) => attachmentKey(other) !== attachmentKey(item)),
            )
          }
        />
        {knowledgeFlow.dialogs}
        <div className="chat-composer-row">
          <ComposerToPicker
            roomMode={roomMode}
            agents={agents}
            offered={offered}
            to={to}
            setTo={setTo}
            planFirst={planFirst}
            setPlanFirst={setPlanFirst}
            textarea={textarea}
          />
          <ComposerAttachControls
            roomMode={roomMode}
            orchestrate={orchestrate}
            pending={pending}
            attachmentCount={attachments.length}
            uploading={uploading}
            fileInput={fileInput}
            upload={upload}
            onPickWorkspace={() => setPickingWorkspace(true)}
            voice={voice}
            toggleVoice={toggleVoice}
            edit={edit}
            textarea={textarea}
            topicCommands={topicCommands}
            setNotice={setNotice}
          />
          <ComposerSendControls
            roomMode={roomMode}
            roomId={roomId}
            agents={agents}
            meterAgents={meterAgents}
            finishedReplies={finishedReplies}
            compactSubject={compactSubject}
            compactSignal={compactSignal}
            writingCount={writing.length}
            text={text}
            editing={Boolean(editing)}
            stopping={stopping}
            hold={hold}
            pending={pending}
            uploading={uploading}
            stopReplies={stopReplies}
          />
        </div>
        {voice.error && (
          <p className="chat-composer-notice chat-composer-notice--error" role="alert">
            {voice.error}
          </p>
        )}
        {roomMode && !footer && (
          <span id={`${ids}-hint`} className="chat-composer-hint">
            @name for one agent, / for commands
          </span>
        )}
      </form>
      {roomMode &&
        footer &&
        footer({ to, subject, finishedReplies, compactSignal, compactSubject })}
    </div>
  )
}
