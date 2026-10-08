// A fixed Score snapshot shaped like docs/design/now-score.png (neutral agents), so the screenshot is stable.
export const fixtureNow = '2026-10-08T21:31:00.000Z'
const at = (minutes: number) => new Date(Date.parse(fixtureNow) + minutes * 60_000).toISOString()

const agent = (id: string, role: string, color: string, shape: string, status = 'idle') => ({
  id,
  name: id,
  role,
  style: { color, shape },
  status,
  activity: null,
  model: null,
  served: true,
})
const block = (
  id: string,
  label: string,
  state: string,
  start: number,
  end: number | null,
  taskId: string | null = null,
) => ({
  id,
  label,
  state,
  start: at(start),
  end: end === null ? null : at(end),
  taskId,
  runId: null,
})
const hop = (
  id: string,
  from: [string, string],
  to: [string, string],
  kind: string,
  minutes: number,
) => ({
  id,
  from: { agentId: from[0], blockId: from[1] },
  to: { agentId: to[0], blockId: to[1] },
  kind,
  at: at(minutes),
})

export function nowFixture(roomId: string) {
  return {
    asOfSeq: 1,
    now: fixtureNow,
    headline: {
      working: 2,
      needsYou: 1,
      text: 'Two agents are working. One thing needs you.',
    },
    lanes: [
      {
        agent: agent('lead', 'Leads the team', '#6B4EFF', 'circle-dot'),
        blocks: [
          block('plan', 'Plan and assign', 'done', -110, -88, 'task-plan'),
          block('report', 'Report', 'planned', 45, 62),
        ],
      },
      {
        agent: agent('builder', 'Builds features', '#19C39A', 'triangle', 'working'),
        blocks: [
          block('read', 'Read layer for task events', 'done', -86, -50, 'task-read'),
          block('fix', 'Fix cursor', 'done', -34, -24),
          block('stream', 'Stream', 'working', -22, null),
          block('ask', 'Waiting on you', 'waiting', -1, null),
          block('stream-next', 'Stream', 'planned', 34, 52),
        ],
      },
      {
        agent: agent('reviewer', 'Reviews changes', '#FFB61E', 'diamond', 'working'),
        blocks: [
          block('review', 'Review', 'done', -48, -37),
          block('rereview', 'Re-review', 'working', -22, null),
          block('signoff', 'Sign off', 'planned', 48, 60),
        ],
      },
      {
        agent: agent('designer', 'Designs, up next', '#FF6B8A', 'square'),
        blocks: [block('states', 'Empty and error states', 'planned', 25, 55)],
      },
    ],
    handoffs: [
      hop('h1', ['lead', 'plan'], ['builder', 'read'], 'handoff', -88),
      hop('h2', ['builder', 'read'], ['reviewer', 'review'], 'review', -50),
      hop('h3', ['reviewer', 'review'], ['builder', 'fix'], 'sent_back', -37),
      hop('h4', ['builder', 'fix'], ['reviewer', 'rereview'], 'handoff', -24),
    ],
    focusApproval: {
      id: 'fixture-approval',
      origin: 'score-run',
      phase: 'human_pending',
      status: 'pending',
      actionable: true,
      linkedTo: null,
      agentId: 'builder',
      title: 'Can I install a package?',
      command: 'npm install ws@8',
      cwd: '/srv/app',
      description: 'Can I install a package?',
      choices: ['once', 'session', 'always', 'deny'],
      createdAt: at(-1),
      expiresAt: null,
      decision: null,
      delivery: 'none',
      blocking: 'Your rule says package installs ask first. Nothing else is blocked.',
      refs: [],
    },
    thread: {
      roomId,
      messages: [
        {
          id: 'fixture-m1',
          roomId,
          author: { kind: 'agent', agentId: 'reviewer' },
          to: [],
          parts: [
            {
              kind: 'text',
              text: 'The cursor uses created_at alone, so two events in the same millisecond get skipped. Make it (created_at, id) and send it back.',
            },
          ],
          createdAt: at(-5),
          streaming: false,
          refs: [],
        },
        {
          id: 'fixture-m2',
          roomId,
          author: { kind: 'agent', agentId: 'builder' },
          to: [],
          parts: [
            {
              kind: 'text',
              text: "Fixed, the cursor is composite now. Re-review is with reviewer. To build the stream I need the websocket library, so I've asked you to approve the install.",
            },
          ],
          createdAt: at(0),
          streaming: false,
          refs: [],
        },
      ],
    },
    madeToday: [
      {
        title: 'Read layer for task events',
        ref: { kind: 'task', taskId: 'task-read' },
        files: [{ path: 'api/events.py', added: 182, removed: 12 }],
        checks: [{ label: 'Read layer tests pass', agentId: 'builder', ok: true }],
      },
    ],
  }
}
