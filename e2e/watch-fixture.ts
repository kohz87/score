import {
  ApprovalSchema,
  WatchOverviewSchema,
  WatchResponseSchema,
} from '../packages/contract/src/index.ts'
import { fixtureNow, nowFixture } from './now-fixture.ts'

// A fixed Watch page shaped like docs/design/watch.png (neutral agents), so the screenshot is stable.
const at = (minutes: number, seconds = 0) =>
  new Date(Date.parse(fixtureNow) + minutes * 60_000 + seconds * 1000).toISOString()
const agents = nowFixture('room-activity-feed').lanes.map((lane) => lane.agent)
const builder = agents.find((agent) => agent.id === 'builder')!

const terminal = (
  seq: number,
  when: string,
  command: string,
  output: string,
  status: string,
  caption: string,
) => ({
  seq,
  at: when,
  agentId: 'builder',
  runId: 'run-1',
  surface: 'terminal',
  terminal: { cwd: '/srv/app', command, output, status },
  caption,
})
const frames = [
  terminal(1, at(-12), 'git status --short', ' M src/events.py', 'ok', 'Checked what had changed'),
  {
    seq: 2,
    at: at(-9, -20),
    agentId: 'builder',
    runId: 'run-1',
    surface: 'editor',
    editor: {
      path: 'api/events.py',
      language: 'python',
      diff: [
        '@@ -38,6 +38,12 @@',
        ' def read_events(after: tuple[float, int]):',
        '     """Events strictly after the cursor."""',
        '     ts, last_id = after',
        '+    return db.execute(',
        '+        "SELECT * FROM task_events "',
        '+        "WHERE (created_at, id) > (?, ?) "',
        '+        "ORDER BY created_at, id LIMIT 200",',
        '+        (ts, last_id),',
        '     ).fetchall()',
      ].join('\n'),
    },
    caption: 'Rewrote read_events to use the composite cursor',
  },
  {
    seq: 3,
    at: at(-6),
    agentId: 'builder',
    runId: 'run-1',
    surface: 'browser',
    browser: {
      url: 'http://localhost:5173/activity',
      title: 'Waiting for live updates',
      imageUrl: null,
    },
    caption: 'Opened the feed in the browser to see it waiting',
  },
  terminal(
    4,
    at(-2, -48),
    'pytest tests/test_events.py -q',
    '......  all passed',
    'ok',
    'Ran the event tests, all passed',
  ),
  terminal(5, at(-1, -8), 'npm view ws version', '8.18.0', 'ok', 'Checked the latest ws version'),
  terminal(6, at(0, 2), 'npm install ws@8', '', 'paused', 'Tried to install ws@8'),
]
const kind = (frame: { surface: string }) =>
  frame.surface === 'terminal' ? 'command' : frame.surface === 'editor' ? 'file' : 'browser'
const markers = [
  ...frames.map((frame) => ({ seq: frame.seq, at: frame.at, kind: kind(frame) })),
  { seq: 6, at: at(0, 2), kind: 'asked' },
]

export const watchFixture = WatchResponseSchema.parse({
  asOfSeq: 1,
  agent: builder,
  live: true,
  sessionId: 'score-room-activity-feed-builder',
  frames,
  markers,
})
export const watchOverviewFixture = WatchOverviewSchema.parse({
  items: [
    {
      agent: builder,
      thumbnail: null,
      status: 'Stopped before installing',
      live: true,
      surface: 'terminal',
    },
    { agent: agents[2], thumbnail: null, status: 'reviewing', live: true, surface: 'editor' },
    { agent: agents[3], thumbnail: null, status: 'idle', live: false, surface: null },
  ],
})
export const watchApprovalFixture = ApprovalSchema.parse({
  ...nowFixture('room-activity-feed').focusApproval,
  createdAt: at(0, 2),
})
