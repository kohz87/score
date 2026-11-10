// The tidied agent page (decision 180) shows memory, skills, plugins, channels, Score access, subagents and recent runs on
// its face, so its screenshots get these answers (captured once from the fake adapter, dates pinned).
export const builderSectionFixtures: Record<string, unknown> = {
  '/api/agents/builder/subagents': {
    agentId: 'builder',
    control: 'limits',
    enabled: true,
    maxConcurrent: 4,
    model: null,
    maxIterations: 50,
    timeoutSeconds: null,
  },
  '/api/agents/builder/mcp': {
    agentId: 'builder',
    enabled: false,
    writesEnabled: false,
    hasToken: false,
    tokenCreatedAt: null,
    available: false,
    url: null,
    command: null,
    postsThisHour: 0,
    postLimitPerHour: 30,
  },
  '/api/agents/builder/memory': {
    items: [
      {
        id: 'm-7eef6c8653c3',
        text: 'Prefers short status updates.',
        source: 'About you',
        at: '2026-10-08T20:00:00.000Z',
      },
      {
        id: 'm-3c74f5a3ae3e',
        text: 'The test suite runs with pnpm test.',
        source: 'Agent notes',
        at: '2026-10-08T20:00:00.000Z',
      },
      {
        id: 'm-ffb10844c33f',
        text: 'Releases go out on Fridays.',
        source: 'Agent notes',
        at: '2026-10-08T20:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
  '/api/agents/builder/channels': {
    items: [
      {
        platform: 'telegram',
        label: 'Telegram',
        status: 'connected',
        detail: null,
        connectCommand: 'hermes -p builder gateway setup',
      },
      {
        platform: 'discord',
        label: 'Discord',
        status: 'disconnected',
        detail: null,
        connectCommand: 'hermes -p builder gateway setup',
      },
      {
        platform: 'slack',
        label: 'Slack',
        status: 'disconnected',
        detail: 'auth_failed',
        connectCommand: 'hermes -p builder gateway setup',
      },
    ],
  },
  '/api/agents/builder/history': {
    items: [
      {
        runId: 'seed_run_feed_approval',
        title: 'Chat run',
        origin: 'score',
        outcome: 'waiting',
        startedAt: '2026-10-08T20:00:00.000Z',
        durationSec: null,
        model: null,
        costUsd: 0,
        task: null,
        brief: null,
        replaySeq: 3,
      },
      {
        runId: 'seed_run_feed_3',
        title: 'Chat run',
        origin: 'score',
        outcome: 'completed',
        startedAt: '2026-10-08T20:00:00.000Z',
        durationSec: 0,
        model: null,
        costUsd: 0,
        task: null,
        brief: null,
        replaySeq: 2,
      },
    ],
    nextCursor: null,
  },
  '/api/agents/builder/routines': {
    items: [],
  },
  '/api/agents/builder/skills': {
    items: [
      {
        name: 'collaboration',
        enabled: true,
      },
      {
        name: 'code-review',
        enabled: true,
      },
      {
        name: 'release-notes',
        enabled: false,
      },
    ],
  },
  '/api/agents/builder/chat-models': { agentId: 'builder', chats: [] },
  '/api/agents/builder/efforts': {
    agentId: 'builder',
    own: null,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    chats: [],
  },
  '/api/settings/plugins?agent=builder': {
    items: [
      {
        id: 'score-bridge',
        label: 'score-bridge',
        enabled: true,
        locked: true,
        description: 'Lets Score see what this agent does.',
      },
      {
        id: 'memory-notes',
        label: 'memory-notes',
        enabled: true,
        locked: false,
        description: 'Keeps short notes between sessions.',
      },
      {
        id: 'browser-helper',
        label: 'browser-helper',
        enabled: false,
        locked: false,
        description: 'Adds a cloud browser tool.',
      },
      {
        id: 'image-tools',
        label: 'image-tools',
        enabled: false,
        locked: false,
        description: null,
      },
    ],
  },
}
