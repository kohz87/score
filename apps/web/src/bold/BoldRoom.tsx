import type { OutsideSession } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useOutletContext,
  useSearchParams,
} from 'react-router'
import { useStream, useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { BoldResults } from './BoldResults.tsx'
import { BookIcon, CloseIcon } from './BoldIcons.tsx'
import { BoldWorkbench } from './BoldWorkbench.tsx'
import { boldResultsLink, boldWorkbenchLink } from './bold-links.ts'
import type { BoldSheetState } from './bold-ui.ts'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood } from './bold-agents.ts'
import { DirectChat } from './direct/DirectChat.tsx'
import { DirectInfo } from './direct/DirectInfo.tsx'
import { BoldElsewhere, forgetBroughtOutsideSessions } from './room/BoldElsewhere.tsx'
import { BoldTeamRoom } from './room/BoldTeamRoom.tsx'
import { roomJobsQuery } from './room/room-queries.ts'
import { ChatInfoButton, ChatMeta } from './chats/ChatHeader.tsx'
import { ChatInfo } from './chats/ChatInfo.tsx'
import { TopicGraph } from './chats/TopicGraph.tsx'
import { ChatList, readFolded, saveFolded } from './chats/ChatList.tsx'
import { chatForRun, chatIsOpen, currentTopic } from './chats/chat-model.ts'
import { useChatLists, useOpenGroup } from './chats/chat-queries.ts'
import { isEveryoneRoom } from './room/room-model.ts'

const PHONE = '(max-width: 860px)'

type SideMode = 'work' | 'info' | 'elsewhere' | 'graph'

/** The room column and the switchable side panel (PLAN 11.3), with the one-to-one as its agent mode (11.7). */
export function BoldRoom() {
  const agentsState = useStreamQuery(agentsQuery)
  const agents = agentsState.data ?? []
  const phone = useMediaQuery(PHONE)
  const { sheetOpen, setSheetOpen } = useOutletContext<BoldSheetState>()
  const location = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [mode, setMode] = useState<SideMode>('info')
  // 3.21.0: the chat list can fold into a rail (remembered per device), and Chat info opens and closes the side panel.
  const [folded, setFolded] = useState(readFolded)
  const [panelShut, setPanelShut] = useState(false)
  const chatLists = useChatLists()
  const [elsewhere, setElsewhere] = useState<OutsideSession | null>(null)
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null)
  // 3.22.0: the side panel is chat info only. The old Library, Runs and Thread addresses open their new homes.
  const notePath = params.get('note')
  const libraryOpen = params.get('library') === '1'
  // 3.21.0 review: the panel opens on Info by default, so a Workbench or Results link (`?work=…`) asks for Work itself.
  const workRequest = params.get('work')
  const [seenWorkRequest, setSeenWorkRequest] = useState<string | null>(null)
  if (workRequest !== seenWorkRequest) {
    setSeenWorkRequest(workRequest)
    if (workRequest) {
      // 3.23.0: `?work=graph` (a run's link, Show graph) opens the Graph tab; the rest ask for Results or the Workbench.
      setMode(workRequest === 'graph' ? 'graph' : 'work')
      setPanelShut(false)
    }
  }
  const runId = params.get('run')
  const navigationType = useNavigationType()
  const sideRef = useRef<HTMLElement>(null)
  const phoneOpenRef = useRef<HTMLButtonElement>(null)
  const phoneCloseRef = useRef<HTMLButtonElement>(null)
  const closeSheetRef = useRef<() => void>(() => undefined)
  const stream = useStream()

  const directId = params.get('with')
  const directAgent = directId ? agents.find((item) => item.id === directId) : undefined
  const directMode = directId !== null
  const chatId = params.get('chat')
  const workbenchVisible =
    !directMode &&
    mode === 'work' &&
    ['workbench', 'code', 'screen', 'draft'].includes(params.get('work') ?? '')
  const openGroup = useOpenGroup(params.get('room'))
  const openGroupJobs = useStreamQuery(
    useMemo(() => roomJobsQuery(openGroup?.id ?? null), [openGroup?.id]),
  ).data
  const everyoneOpen = openGroup !== null && isEveryoneRoom(openGroup)
  // 3.23.0: the Graph tab belongs to the current topic when it holds a run.
  const currentJob = currentTopic(openGroupJobs ?? [], params.get('job'))
  const graphJob =
    !directMode && currentJob?.recipe && !currentJob.isDefault ? currentJob : undefined
  const shownMode: SideMode = mode === 'graph' && !graphJob ? 'info' : mode
  // On a phone `/b` is the chat list; a chat (or any view of one) is open when the address names it.
  // A one-shot parameter that the chat consumes (a replace) must not drop the person back to the list: the chat stays
  // open until a push or pop (Back, a tab) arrives without one.
  const [chatKept, setChatKept] = useState(false)
  const argued = chatIsOpen(params)
  if (argued && !chatKept) setChatKept(true)
  else if (!argued && chatKept && navigationType !== 'REPLACE') setChatKept(false)
  const showList = phone && !argued && !chatKept
  // Pushing `/b` while the phone sheet is open lands on the list: the sheet closes with it.
  useEffect(() => {
    if (showList && sheetOpen) setSheetOpen(false)
  }, [showList, sheetOpen, setSheetOpen])
  const panelClosed = !phone && panelShut
  // A one-to-one is a chat: its side panel is the chat's Info.
  const infoShown = !panelClosed && (shownMode === 'info' || directMode)
  const graphShown = !panelClosed && shownMode === 'graph'
  const toggleInfo = () => {
    if (infoShown) {
      setPanelShut(true)
      return
    }
    setMode('info')
    setPanelShut(false)
  }
  const selectedChat = directMode
    ? `direct:${directId}`
    : openGroup
      ? `group:${openGroup.id}`
      : null
  const label =
    shownMode === 'elsewhere'
      ? `${elsewhere?.agentId ?? 'Elsewhere'} · ${elsewhere?.sourceLabel ?? ''}`.trim()
      : 'Info'
  const elsewhereAgent = elsewhere
    ? agents.find((item) => item.id === elsewhere.agentId)
    : undefined

  useEffect(() => {
    if (!phone || !sheetOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const dialog =
        event.target instanceof Element
          ? event.target.closest('[role="dialog"], [aria-modal="true"]')
          : null
      // The sheet itself is labelled aria-modal; a dialog *inside* it owns its own Escape.
      if (dialog && dialog !== sideRef.current) return
      event.preventDefault()
      closeSheetRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [phone, sheetOpen])

  useEffect(() => {
    if (phone && sheetOpen) phoneCloseRef.current?.focus()
  }, [phone, sheetOpen])

  useEffect(() => {
    if (!phone) setSheetOpen(false)
  }, [phone, setSheetOpen])

  useEffect(() => () => forgetBroughtOutsideSessions(), [])

  useEffect(
    () =>
      stream.subscribe((event) => {
        if (event.type !== 'job.deleted') return
        if (params.get('job') !== event.data.id) return
        const next = new URLSearchParams(params)
        next.delete('job')
        next.delete('message')
        next.delete('work')
        next.delete('file')
        if (phone) setSheetOpen(false)
        // Same history state as the team room's own handler, so whichever runs last leaves the same entry.
        setParams(next, { replace: true, state: location.state })
        setDeletedNotice('That job was deleted.')
      }),
    [location.state, params, phone, setParams, setSheetOpen, stream],
  )

  useEffect(() => {
    if (!deletedNotice) return
    const timer = setTimeout(() => setDeletedNotice(null), 5_000)
    return () => clearTimeout(timer)
  }, [deletedNotice])

  // Old addresses redirect (3.22.0): a note or the Library opens on the Knowledge page, a run on the Recipes page.
  useEffect(() => {
    if (notePath !== null || libraryOpen) {
      const target = new URLSearchParams()
      if (notePath) target.set('note', notePath)
      void navigate(`/b/knowledge${target.size ? `?${target}` : ''}`, { replace: true })
    } else if (runId) {
      // Wait for the chats' jobs: a run that belongs to a chat opens there, otherwise on the Recipes page.
      if (!chatLists.ready || !chatLists.jobsSettled) return
      const chat = chatForRun(chatLists, chatLists.jobsByRoom, runId)
      // 3.23.0: a run that belongs to a chat lands on its topic with the Graph tab open (a one-to-one has no graph).
      void navigate(
        chat
          ? chat.startsWith('/b?with=')
            ? chat
            : `${chat}&work=graph`
          : `/b/recipes?run=${encodeURIComponent(runId)}`,
        { replace: true },
      )
    }
  }, [chatLists, libraryOpen, navigate, notePath, runId])

  const withoutDirect = (next: URLSearchParams) => {
    next.delete('with')
    next.delete('chat')
    next.delete('ref')
    next.delete('run')
    return next
  }

  const choose = (next: SideMode) => {
    setMode(next)
    setPanelShut(false)
    setParams(withoutDirect(new URLSearchParams(params)), { replace: true })
  }

  const openElsewhere = (session: OutsideSession) => {
    setElsewhere(session)
    setMode('elsewhere')
    setPanelShut(false)
    setParams(withoutDirect(new URLSearchParams(params)), { replace: true })
    setSheetOpen(true)
    if (!phone)
      requestAnimationFrame(() =>
        sideRef.current?.querySelector<HTMLElement>('.bold-elsewhere h2')?.focus(),
      )
  }
  const broughtIntoJob = (jobId: string) => {
    setMode('work')
    setSheetOpen(false)
    void navigate(`/b?job=${encodeURIComponent(jobId)}`)
    if (phone) requestAnimationFrame(() => phoneOpenRef.current?.focus())
  }
  const openThread = (jobId: string | null) => {
    // The chat is the thread now: a thread link makes that topic current and scrolls to it.
    const next = withoutDirect(new URLSearchParams(params))
    if (jobId) next.set('job', jobId)
    else next.delete('job')
    setParams(next, { replace: true })
  }

  const showGraph = (jobId: string) => {
    const next = withoutDirect(new URLSearchParams(params))
    next.set('job', jobId)
    next.delete('message')
    next.delete('jobs')
    // Not `?work=graph`: the tab is state, and the same address keeps working when the person picks Info again.
    setMode('graph')
    setPanelShut(false)
    setParams(next, { replace: true })
    if (phone) setSheetOpen(true)
  }

  const closeSheet = () => {
    setSheetOpen(false)
    requestAnimationFrame(() => phoneOpenRef.current?.focus())
  }

  // The sheet's Escape closes it the same way its own close button does.
  useEffect(() => {
    closeSheetRef.current = closeSheet
  })

  const phoneAction = phone ? (
    <button
      ref={phoneOpenRef}
      type="button"
      className="btn sm phone-side-open"
      aria-label="Open side panel"
      aria-expanded={sheetOpen}
      aria-controls="bold-side-panel"
      onClick={() => setSheetOpen(true)}
    >
      <BookIcon /> <span className="phone-side-label">Open side panel</span>
    </button>
  ) : undefined

  const chatList = (
    <ChatList
      lists={chatLists}
      ready={chatLists.ready}
      selected={selectedChat}
      phone={phone}
      folded={folded}
      onFold={(next) => {
        setFolded(next)
        saveFolded(next)
      }}
    />
  )
  if (showList) return <div className="roomgrid bold-chats">{chatList}</div>

  return (
    <div
      className={`roomgrid bold-chats${panelClosed ? ' bold-panel-shut' : ''}${infoShown || graphShown ? ' bold-info-open' : ' bold-wide-panel'}${graphShown ? ' bold-graph-open' : ''}`}
    >
      {!phone && chatList}
      {deletedNotice && (
        <p className="bold-job-lifecycle-notice" data-protected="block" role="status">
          {deletedNotice}
        </p>
      )}
      <section
        className="roomcol"
        aria-label={directAgent ? `Chat with ${agentDisplayName(directAgent)}` : 'Team room'}
        inert={phone && sheetOpen}
      >
        {directMode ? (
          directAgent ? (
            <DirectChat
              key={directAgent.id}
              agent={directAgent}
              agents={agents}
              phone={phone}
              infoOpen={infoShown}
              onToggleInfo={toggleInfo}
              infoRef={phoneOpenRef}
              infoExpanded={sheetOpen}
              onChatInfo={() => {
                setPanelShut(false)
                setSheetOpen(true)
              }}
              onBackToChats={() => {
                setSheetOpen(false)
                void navigate('/b')
              }}
            />
          ) : (
            <p className="bold-stream-note bold-dm-status" role="status">
              {agentsState.status === 'pending'
                ? 'Opening your chats…'
                : 'That agent isn’t on your team any more.'}
            </p>
          )
        ) : (
          <BoldTeamRoom
            agents={agents}
            phone={phone}
            phoneAction={phoneAction}
            onOpenElsewhere={openElsewhere}
            onOpenThread={openThread}
            onShowGraph={showGraph}
            externalDeletedNotice
            chatMeta={(room) => <ChatMeta room={room} agents={agents} />}
            chatAction={() => <ChatInfoButton open={infoShown} onToggle={toggleInfo} />}
            infoRef={phoneOpenRef}
            infoExpanded={sheetOpen}
            onChatInfo={() => {
              setMode('info')
              setPanelShut(false)
              setSheetOpen(true)
            }}
            onBackToChats={() => {
              setSheetOpen(false)
              void navigate('/b')
            }}
          />
        )}
      </section>

      <div
        className={`bold-sidecol${phone && sheetOpen ? ' open' : ''}`}
        hidden={(phone && !sheetOpen) || panelClosed}
      >
        <aside
          className="side"
          id="bold-side-panel"
          ref={sideRef}
          aria-label="Side panel"
          aria-modal={phone && sheetOpen ? true : undefined}
        >
          <div className="sidehead">
            {shownMode === 'elsewhere' && !directMode && elsewhereAgent ? (
              <span className="bold-elsewhere-label">
                <AgentGlyph
                  agent={elsewhereAgent}
                  size="sm"
                  bare
                  decorative
                  mood={agentMood(elsewhereAgent)}
                />{' '}
                {label}
              </span>
            ) : (
              <div className="bold-side-tabs" role="tablist" aria-label="Panel">
                <button
                  type="button"
                  role="tab"
                  aria-selected={directMode || shownMode === 'info'}
                  className={directMode || shownMode === 'info' ? 'on' : undefined}
                  onClick={() => (directMode ? undefined : choose('info'))}
                >
                  Info
                </button>
                {!directMode && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={shownMode === 'work'}
                    className={shownMode === 'work' ? 'on' : undefined}
                    onClick={() => choose('work')}
                  >
                    Results
                  </button>
                )}
                {graphJob && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={shownMode === 'graph'}
                    className={shownMode === 'graph' ? 'on' : undefined}
                    onClick={() => choose('graph')}
                  >
                    Graph
                  </button>
                )}
              </div>
            )}
            {shownMode === 'work' && !directMode && (
              <nav className="seg bold-work-tabs" aria-label="How to see the work">
                <Link
                  className={workbenchVisible ? undefined : 'on'}
                  aria-current={workbenchVisible ? undefined : 'page'}
                  to={boldResultsLink(location.search)}
                >
                  Results
                </Link>
                <Link
                  className={workbenchVisible ? 'on' : undefined}
                  aria-current={workbenchVisible ? 'page' : undefined}
                  to={boldWorkbenchLink(location.search)}
                >
                  Workbench
                </Link>
              </nav>
            )}
            {phone && (
              <button
                ref={phoneCloseRef}
                type="button"
                className="icon-btn sm sideclose"
                aria-label="Close side panel"
                onClick={closeSheet}
              >
                <CloseIcon />
              </button>
            )}
          </div>

          {directMode ? (
            directAgent ? (
              <DirectInfo
                agent={directAgent}
                agents={agents}
                chatId={chatId}
                onNavigate={() => setSheetOpen(false)}
              />
            ) : (
              <ChatInfo
                room={null}
                agents={agents}
                jobs={[]}
                everyone={false}
                phone={phone}
                onNavigate={() => setSheetOpen(false)}
              />
            )
          ) : shownMode === 'graph' && graphJob ? (
            <TopicGraph key={graphJob.id} job={graphJob} />
          ) : shownMode === 'info' ? (
            <ChatInfo
              room={openGroup}
              agents={agents}
              jobs={openGroupJobs ?? []}
              everyone={everyoneOpen}
              phone={phone}
              onNavigate={() => setSheetOpen(false)}
            />
          ) : shownMode === 'elsewhere' && elsewhere ? (
            <BoldElsewhere
              key={`${elsewhere.agentId}:${elsewhere.id}`}
              session={elsewhere}
              agents={agents}
              onBroughtIn={broughtIntoJob}
            />
          ) : null}
          <BoldResults
            agents={agents}
            hidden={directMode || shownMode !== 'work' || workbenchVisible}
          />
          <BoldWorkbench agents={agents} hidden={directMode || !workbenchVisible} />
        </aside>
      </div>
    </div>
  )
}
