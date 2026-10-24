-- PLAN 11.1c (docs/briefs/11.1c-budgets.md): budgets and pauses. When Score can't give an exchange its next turn (a
-- limit, a failed turn, an agent that can't take work), that turn is held on the exchange with the reason, and the
-- person decides. Nothing is queued while it waits, so nothing spends.
ALTER TABLE exchanges ADD COLUMN pause_reason TEXT CHECK (pause_reason IN (
  'exchange_budget', 'job_limit', 'spend_cap', 'cost_unknown', 'turn_failed', 'unreachable', 'asker_gone',
  'no_decision', 'author_stalled'));
-- The held turn: {"agentId","input","parentMessageId","chainId","fromAgentId"}.
ALTER TABLE exchanges ADD COLUMN held TEXT CHECK (held IS NULL OR json_valid(held));
-- The room lead's turn deciding a budget pause ("Let lead decide"), while it runs.
ALTER TABLE exchanges ADD COLUMN decider_turn_id TEXT;
-- "Continue" on a run of unknown cost accepts the unknown costs seen so far; a later one pauses again.
ALTER TABLE jobs ADD COLUMN cost_unknown_accepted_at TEXT;

-- The lead's decision on a budget pause adds two actions: rebuilt for the wider CHECK (nothing references this table).
CREATE TABLE exchange_actions_new (
  turn_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('handoff', 'ask', 'review', 'approve', 'send_back', 'reply', 'extend',
    'stop_exchange')),
  args TEXT NOT NULL CHECK (json_valid(args)),
  channel TEXT NOT NULL CHECK (channel IN ('bridge', 'block')),
  state TEXT NOT NULL CHECK (state IN ('staged', 'refused', 'replaced', 'applied', 'dropped')),
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn_id, command_id)
) STRICT;
INSERT INTO exchange_actions_new SELECT turn_id, command_id, action, args, channel, state, receipt, created_at
  FROM exchange_actions;
DROP TABLE exchange_actions;
ALTER TABLE exchange_actions_new RENAME TO exchange_actions;
