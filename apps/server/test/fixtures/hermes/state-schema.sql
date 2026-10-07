# user_version: 0 | journal: wal
-- messages_display_identity_delete
CREATE TRIGGER messages_display_identity_delete
AFTER DELETE ON messages WHEN old.active = 1 OR old.compacted = 1
BEGIN
    UPDATE messages SET display_order = (
        SELECT MIN(peer.id) FROM messages AS peer
        WHERE peer.session_id = old.session_id AND (peer.active = 1 OR peer.compacted = 1)
          AND peer.display_identity = old.display_identity
    ) WHERE session_id = old.session_id AND (active = 1 OR compacted = 1)
      AND display_identity = old.display_identity;
END;
-- messages_display_identity_update
CREATE TRIGGER messages_display_identity_update
AFTER UPDATE OF role, content, timestamp, tool_call_id, tool_calls, tool_name,
                display_kind ON messages
WHEN new.role IS NOT old.role
  OR new.content IS NOT old.content
  OR new.timestamp IS NOT old.timestamp
  OR new.tool_call_id IS NOT old.tool_call_id
  OR new.tool_calls IS NOT old.tool_calls
  OR new.tool_name IS NOT old.tool_name
  OR new.display_kind IS NOT old.display_kind
BEGIN
    UPDATE messages SET display_identity = NULL, display_order = NULL
    WHERE id = new.id OR (
        session_id = old.session_id AND display_identity = old.display_identity
        AND (active = 1 OR compacted = 1)
    );
END;
-- messages_display_order_insert
CREATE TRIGGER messages_display_order_insert
AFTER INSERT ON messages WHEN new.display_order IS NULL
BEGIN
    UPDATE messages SET display_order = COALESCE((
        SELECT display_order FROM messages
        WHERE session_id = new.session_id AND id <> new.id
          AND (active = 1 OR compacted = 1)
          AND display_identity = new.display_identity AND display_order IS NOT NULL
        ORDER BY display_order LIMIT 1
    ), new.id) WHERE id = new.id;
END;
-- messages_display_visibility_update
CREATE TRIGGER messages_display_visibility_update
AFTER UPDATE OF active, compacted ON messages
WHEN (new.active = 1 OR new.compacted = 1) <> (old.active = 1 OR old.compacted = 1)
BEGIN
    UPDATE messages SET display_order = MIN(new.id, COALESCE((
        SELECT display_order FROM messages
        WHERE session_id = new.session_id AND id <> new.id
          AND (active = 1 OR compacted = 1)
          AND display_identity = new.display_identity AND display_order IS NOT NULL
        ORDER BY display_order LIMIT 1
    ), new.id)) WHERE id = new.id
      AND (new.active = 1 OR new.compacted = 1);
    UPDATE messages SET display_order = (SELECT display_order FROM messages WHERE id = new.id)
    WHERE session_id = new.session_id AND id <> new.id AND (active = 1 OR compacted = 1)
      AND display_identity = new.display_identity
      AND (new.active = 1 OR new.compacted = 1);
    UPDATE messages SET display_order = (
        SELECT MIN(peer.id) FROM messages AS peer
        WHERE peer.session_id = old.session_id AND (peer.active = 1 OR peer.compacted = 1)
          AND peer.display_identity = old.display_identity
    ) WHERE session_id = old.session_id AND (active = 1 OR compacted = 1)
      AND display_identity = old.display_identity
      AND NOT (new.active = 1 OR new.compacted = 1);
END;
-- messages_message_uid_insert
CREATE TRIGGER messages_message_uid_insert
AFTER INSERT ON messages WHEN new.message_uid IS NULL
BEGIN
    -- Every row carries a message_uid, whoever wrote it: a build that predates the column binds NULL, so
    -- the store mints one on its behalf (the current build always binds a uid; this never fires for it).
    -- The note lives inside the body: a comment before DROP/CREATE would defeat the settled-trigger skip.
    UPDATE messages SET message_uid = lower(hex(randomblob(16))) WHERE id = new.id;
END;
-- async_delegations  (rows: 0)
CREATE TABLE async_delegations (
    delegation_id TEXT PRIMARY KEY,
    origin_session TEXT NOT NULL,
    origin_ui_session_id TEXT NOT NULL DEFAULT '',
    parent_session_id TEXT,
    state TEXT NOT NULL,
    dispatched_at REAL NOT NULL,
    completed_at REAL,
    updated_at REAL NOT NULL,
    event_json TEXT,
    result_json TEXT,
    delivery_state TEXT NOT NULL DEFAULT 'pending',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    delivered_at REAL,
    owner_pid INTEGER,
    owner_started_at INTEGER,
    task_json TEXT,
    delivery_claim TEXT,
    delivery_claimed_at REAL,
    -- Mirrors the delegation tool's own CREATE TABLE (tools/async_delegation.py
    -- _initialize_schema). Keeping the canonical fresh-install shape identical
    -- to the tool's avoids a silent schema drift: the tool's lazy
    -- ALTER TABLE ADD COLUMN used to be the only source of this column, so two
    -- databases at the same schema_version had different
    -- async_delegations shapes depending on whether the delegation tool had
    -- ever run, breaking rebuild/replay pipelines that reconstruct state.db
    -- from the canonical schema (#94691).
    origin_session_id TEXT NOT NULL DEFAULT ''
);
-- compression_locks  (rows: 0)
CREATE TABLE compression_locks (
    session_id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
-- conversation_generations  (rows: 0)
CREATE TABLE conversation_generations (
    source TEXT NOT NULL,
    session_key TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, session_key)
);
-- delivery_obligations  (rows: 0)
CREATE TABLE delivery_obligations (
            obligation_id TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            platform TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            thread_id TEXT,
            content TEXT NOT NULL,
            state TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            owner_pid INTEGER,
            owner_started_at INTEGER,
            last_error TEXT,
            adapter_profile TEXT
        );
-- gateway_heartbeats  (rows: 0)
CREATE TABLE gateway_heartbeats (
    backend_id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at REAL NOT NULL,
    last_heartbeat REAL NOT NULL,
    profile TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT ''
);
-- gateway_hygiene_state  (rows: 0)
CREATE TABLE gateway_hygiene_state (
    session_key TEXT PRIMARY KEY,
    failure_streak INTEGER NOT NULL DEFAULT 0
);
-- gateway_routing  (rows: 0)
CREATE TABLE gateway_routing (
    scope TEXT NOT NULL DEFAULT '',
    session_key TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (scope, session_key)
);
-- messages  (rows: 0)
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    effect_disposition TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT,
    codex_message_items TEXT,
    platform_message_id TEXT,
    observed INTEGER DEFAULT 0,
    _compressed_summary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0,
    api_content TEXT,
    display_kind TEXT,
    display_metadata TEXT,
    display_identity BLOB,
    display_order INTEGER,
    message_uid TEXT,
    absorbed_message_uids TEXT,
    tool_call_uids TEXT,
    tool_call_uid TEXT
);
-- messages_fts  (rows: 0)
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    tool_name,
    tool_calls,
    content='messages_fts_src',
    content_rowid='id'
);
-- schema_version  (rows: 1)
CREATE TABLE schema_version (
    version INTEGER NOT NULL
);
-- session_model_usage  (rows: 0)
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    cost_status TEXT,
    cost_source TEXT,
    first_seen REAL,
    last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
);
-- session_turn_leases  (rows: 0)
CREATE TABLE session_turn_leases (
    conversation_id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    acquired_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
-- sessions  (rows: 0)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    created_source TEXT,
    user_id TEXT,
    session_key TEXT,
    chat_id TEXT,
    chat_type TEXT,
    thread_id TEXT,
    display_name TEXT,
    origin_json TEXT,
    expiry_finalized INTEGER DEFAULT 0,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    system_prompt_hash TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cwd TEXT,
    git_branch TEXT,
    git_repo_root TEXT,
    git_metadata_generation INTEGER NOT NULL DEFAULT 0,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    title TEXT,
    title_source TEXT,
    last_activity_at REAL,
    last_activity_description TEXT,
    last_activity_provenance TEXT,
    api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT,
    handoff_platform TEXT,
    handoff_error TEXT,
    compression_failure_cooldown_until REAL,
    compression_failure_error TEXT,
    compression_fallback_streak INTEGER NOT NULL DEFAULT 0,
    compression_ineffective_count INTEGER NOT NULL DEFAULT 0,
    compression_recovery_deadline REAL,
    compression_overload_streak INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT,
    transport_profile TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    auto_archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    last_read_at REAL,
    tool_names TEXT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
    FOREIGN KEY (system_prompt_hash) REFERENCES system_prompts(hash)
);
-- state_meta  (rows: 8)
CREATE TABLE state_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
-- system_prompts  (rows: 0)
CREATE TABLE system_prompts (
    hash TEXT PRIMARY KEY,
    prompt TEXT NOT NULL
);
-- idx_async_delegations_delivery
CREATE INDEX idx_async_delegations_delivery
    ON async_delegations(delivery_state, completed_at);
-- idx_compression_locks_expires
CREATE INDEX idx_compression_locks_expires ON compression_locks(expires_at);
-- idx_messages_active_null
CREATE INDEX idx_messages_active_null
    ON messages(active) WHERE active IS NULL;
-- idx_messages_assistant_calls_by_session
CREATE INDEX idx_messages_assistant_calls_by_session
    ON messages(session_id)
    WHERE role = 'assistant' AND tool_calls IS NOT NULL;
-- idx_messages_display_backfill
CREATE INDEX idx_messages_display_backfill
    ON messages(session_id) WHERE (display_order IS NULL OR display_identity IS NULL)
    AND (active = 1 OR compacted = 1);
-- idx_messages_display_identity
CREATE INDEX idx_messages_display_identity
    ON messages(session_id, display_identity, display_order)
    WHERE display_identity IS NOT NULL AND (active = 1 OR compacted = 1);
-- idx_messages_display_page
CREATE INDEX idx_messages_display_page
    ON messages(session_id, display_order, active DESC, id DESC)
    WHERE active = 1 OR compacted = 1;
-- idx_messages_platform_msg_id
CREATE INDEX idx_messages_platform_msg_id ON messages(session_id, platform_message_id) WHERE platform_message_id IS NOT NULL;
-- idx_messages_session
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
-- idx_messages_session_active
CREATE INDEX idx_messages_session_active
    ON messages(session_id, active, timestamp);
-- idx_messages_session_id
CREATE INDEX idx_messages_session_id ON messages(session_id, id);
-- idx_messages_session_uid
CREATE INDEX idx_messages_session_uid
    ON messages(session_id, message_uid) WHERE active = 1;
-- idx_session_model_usage_model
CREATE INDEX idx_session_model_usage_model ON session_model_usage(model);
-- idx_session_model_usage_session
CREATE INDEX idx_session_model_usage_session ON session_model_usage(session_id);
-- idx_session_turn_leases_expires
CREATE INDEX idx_session_turn_leases_expires ON session_turn_leases(expires_at);
-- idx_sessions_effective_activity
CREATE INDEX idx_sessions_effective_activity
    ON sessions(COALESCE(last_activity_at, started_at) DESC, started_at DESC);
-- idx_sessions_gateway_peer
CREATE INDEX idx_sessions_gateway_peer
    ON sessions(source, user_id, chat_id, chat_type, thread_id, started_at DESC);
-- idx_sessions_handoff_state
CREATE INDEX idx_sessions_handoff_state
    ON sessions(handoff_state, started_at);
-- idx_sessions_parent
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
-- idx_sessions_session_key
CREATE INDEX idx_sessions_session_key
    ON sessions(session_key, started_at DESC);
-- idx_sessions_source
CREATE INDEX idx_sessions_source ON sessions(source);
-- idx_sessions_source_id
CREATE INDEX idx_sessions_source_id ON sessions(source, id);
-- idx_sessions_started
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
-- idx_sessions_system_prompt_hash
CREATE INDEX idx_sessions_system_prompt_hash
    ON sessions(system_prompt_hash);
-- idx_sessions_title_unique
CREATE UNIQUE INDEX idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL;
-- idx_sessions_tool_names
CREATE INDEX idx_sessions_tool_names
    ON sessions(tool_names);
