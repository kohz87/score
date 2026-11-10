import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { getEpoch, migrate } from '../src/db/index.ts'
import { copyMigrations, dir, migrationDir, open } from './db-helpers.ts'

test('fresh db migrates all infrastructure tables and records checksums', () => {
  const db = open()
  migrate(db, migrationDir)
  const migrations = readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  expect(db.sqlite.prepare('SELECT * FROM schema_migrations').all()).toEqual(
    migrations.map((name) => ({
      version: Number(name.slice(0, 4)),
      name,
      checksum: createHash('sha256')
        .update(readFileSync(join(migrationDir, name)))
        .digest('hex'),
      applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    })),
  )
  const tables = db.sqlite
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all()
  expect(tables.map((row) => row.name)).toEqual([
    'agent_lifecycle',
    'agent_paused_tasks',
    'agent_pauses',
    'agent_questions',
    'agent_rule_overrides',
    'agent_styles',
    'agents_proj',
    'approval_deliveries',
    'approval_delivery_leases',
    'approval_signals',
    'approvals',
    'bot_takeovers',
    'brief_blocks',
    'brief_edges',
    'brief_paused_tasks',
    'brief_plan_starts',
    'brief_tasks',
    'briefs',
    'chat_efforts',
    'chat_models',
    'checked_cli_versions',
    'coding_agents',
    'coding_journal_checkpoint',
    'coding_launches',
    'coding_pending_terminals',
    'coding_process_members',
    'coding_processes',
    'coding_quota',
    'coding_refusals',
    'coding_releases',
    'coding_run_results',
    'coding_sessions',
    'command_intents',
    'credentials',
    'events',
    'exchange_actions',
    'exchanges',
    'fake_profiles',
    'gaps',
    'ingest_checkpoints',
    'ingest_floors',
    'ingest_keys',
    'job_reads',
    'job_sessions',
    'jobs',
    'kanban_associations',
    'kanban_attempt_observations',
    'kanban_attempts',
    'kanban_histories',
    'kanban_pages',
    'kanban_seen_events',
    'kanban_sources',
    'kanban_upgrade_links',
    'kanban_upgrade_state',
    'knowledge_agent_access',
    'knowledge_agent_writes',
    'knowledge_doc_fts',
    'knowledge_doc_fts_config',
    'knowledge_doc_fts_content',
    'knowledge_doc_fts_data',
    'knowledge_doc_fts_docsize',
    'knowledge_doc_fts_idx',
    'knowledge_documents',
    'knowledge_fts',
    'knowledge_fts_config',
    'knowledge_fts_content',
    'knowledge_fts_data',
    'knowledge_fts_docsize',
    'knowledge_fts_idx',
    'knowledge_links',
    'knowledge_notes',
    'knowledge_settings',
    'mcp_access',
    'mcp_posts',
    'media',
    'message_fts',
    'message_fts_config',
    'message_fts_content',
    'message_fts_data',
    'message_fts_docsize',
    'message_fts_idx',
    'message_runs',
    'messages',
    'meta',
    'model_visibility',
    'orc_agent_map',
    'orc_attempts',
    'orc_capabilities',
    'orc_causes',
    'orc_checks',
    'orc_commands',
    'orc_fence_items',
    'orc_gates',
    'orc_generations',
    'orc_global',
    'orc_history',
    'orc_inquiries',
    'orc_quota_holds',
    'orc_steps',
    'orc_votes',
    'orc_worker_policies',
    'orchestrations',
    'passkeys',
    'plan_start_runs',
    'producers',
    'profile_operations',
    'recipe_schedules',
    'remote_sessions',
    'request_receipts',
    'review_comments',
    'rewind_holds',
    'room_pins',
    'room_projects',
    'room_queue',
    'room_reads',
    'room_sessions',
    'room_shares',
    'room_versions',
    'rooms',
    'routine_outputs_posted',
    'routine_targets',
    'run_thinking',
    'runs',
    'schema_migrations',
    'session_cost_snapshots',
    'session_successors',
    'session_tool_calls',
    'sessions',
    'share_media',
    'subagent_agents',
    'subagent_sessions',
    'subagents',
    'task_projections',
    'task_rooms',
    'team_paused_briefs',
    'team_paused_tasks',
    'team_rules',
    'team_state',
    'theme_swaps',
    'themes',
    'tool_calls',
    'trigger_calls',
    'triggers',
    'watch_frames',
    'wf_commands',
    'wf_consumed',
    'wf_gates',
    'wf_nodes',
    'wf_results',
    'wf_runs',
    'wf_steps',
    'wf_tokens',
    'workflow_definitions',
    'workflow_versions',
    'workspace_agents',
    'workspaces',
  ])
  expect(
    db.sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('events_ts', 'gaps_run', 'ingest_keys_position') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: 'events_ts' }, { name: 'gaps_run' }, { name: 'ingest_keys_position' }])
  expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'created_at'").get()).toEqual({
    value: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
  })
})

test('re-running migrations is a no-op including epoch and applied timestamp', () => {
  const db = open()
  migrate(db, migrationDir)
  const before = db.sqlite.prepare('SELECT * FROM schema_migrations').all()
  const meta = db.sqlite.prepare('SELECT * FROM meta ORDER BY key').all()
  const changes = db.sqlite.prepare('SELECT total_changes() AS count').get()
  migrate(db, migrationDir)
  expect(db.sqlite.prepare('SELECT * FROM schema_migrations').all()).toEqual(before)
  expect(db.sqlite.prepare('SELECT * FROM meta ORDER BY key').all()).toEqual(meta)
  expect(db.sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
})

test('modified applied migration is rejected before any further migration', () => {
  const db = open()
  const copy = copyMigrations()
  migrate(db, copy)
  writeFileSync(
    join(copy, '0001_infra.sql'),
    readFileSync(join(copy, '0001_infra.sql'), 'utf8') + '\n-- changed\n',
  )
  writeFileSync(join(copy, '0002_next.sql'), "INSERT INTO meta VALUES ('next', 'value');")
  expect(() => migrate(db, copy)).toThrow('Applied migration changed: 0001_infra.sql')
  expect(db.sqlite.prepare("SELECT * FROM meta WHERE key = 'next'").get()).toBeUndefined()
})

test.each(['0003_gap.sql', '0001_duplicate.sql', 'invalid.sql'])(
  'invalid migration sequence %s is rejected before applying SQL',
  (name) => {
    const db = open()
    const copy = copyMigrations()
    writeFileSync(join(copy, name), 'SELECT 1;')
    expect(() => migrate(db, copy)).toThrow(
      name.includes('gap')
        ? 'Missing migration number: 2'
        : name.includes('duplicate')
          ? 'Duplicate migration number: 1'
          : 'Invalid migration filename',
    )
    expect(db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
      [],
    )
  },
)

test('migration sequence must start at one', () => {
  const db = open()
  const copy = join(dir, 'migrations')
  mkdirSync(copy)
  writeFileSync(join(copy, '0002_next.sql'), 'SELECT 1;')
  expect(() => migrate(db, copy)).toThrow('Missing migration number: 1')
})

test('empty migration directory is rejected', () => {
  const copy = join(dir, 'migrations')
  mkdirSync(copy)
  expect(() => migrate(open(), copy)).toThrow('Missing migration number: 1')
})

test('database from a newer Score is rejected', () => {
  const db = open()
  migrate(db, migrationDir)
  db.sqlite
    .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
    .run(1000, '1000_newer.sql', 'a'.repeat(64), new Date().toISOString())
  expect(() => migrate(db, migrationDir)).toThrow(
    'Database is from a newer Score: unknown applied migration 1000',
  )
})

test('a gap in applied migration history is rejected', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(join(copy, '0002_next.sql'), 'SELECT 1;')
  migrate(db, copy)
  db.sqlite.exec('DELETE FROM schema_migrations WHERE version = 1')
  expect(() => migrate(db, copy)).toThrow('Missing applied migration number: 1')
})

test('later migrations run in order in separate transactions', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(
    join(copy, '0003_third.sql'),
    "UPDATE meta SET value = value || '-third' WHERE key = 'order';",
  )
  writeFileSync(join(copy, '0002_second.sql'), "INSERT INTO meta VALUES ('order', 'second');")
  migrate(db, copy)
  expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'order'").get()).toEqual({
    value: 'second-third',
  })
  expect(db.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
    [{ version: 1 }, { version: 2 }, { version: 3 }],
  )
})

test('failed migration rolls back its writes and ledger entry while preserving previous migrations', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(
    join(copy, '0002_failure.sql'),
    "INSERT INTO meta VALUES ('partial', 'value'); INSERT INTO missing_table VALUES (1);",
  )
  expect(() => migrate(db, copy)).toThrow('no such table')
  expect(db.sqlite.prepare("SELECT * FROM meta WHERE key = 'partial'").get()).toBeUndefined()
  expect(db.sqlite.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }])
  expect(getEpoch(db)).toMatch(/^[a-f0-9]{32}$/)
  writeFileSync(join(copy, '0002_failure.sql'), "INSERT INTO meta VALUES ('partial', 'complete');")
  migrate(db, copy)
  expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'partial'").get()).toEqual({
    value: 'complete',
  })
})

test('failed first migration leaves no tables or epoch', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(
    join(copy, '0001_infra.sql'),
    readFileSync(join(copy, '0001_infra.sql'), 'utf8') + '\nINVALID SQL;',
  )
  expect(() => migrate(db, copy)).toThrow()
  expect(db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([])
  cpSync(join(migrationDir, '0001_infra.sql'), join(copy, '0001_infra.sql'))
  migrate(db, copy)
  expect(getEpoch(db)).toMatch(/^[a-f0-9]{32}$/)
})
