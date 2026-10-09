# Proposal: forward lifecycle status on the Runs API event stream

**For:** Hermes Agent (api_server_runs). **Why:** an API client sees nothing while a turn waits. On 2026-10-09 a turn on
a free Nous model got 429 "fair-share rate limit"; `agent.conversation_loop` logged "Retrying API call in 600s
(attempt 1/3)" and buffered/emitted a diagnostic status, but `/v1/runs/{id}/events` carried no event for ~14 minutes, so
Score could only show an empty "streaming" reply until the person cancelled.

**Ask:** pass a `status_callback` into the agent created by `api_server_runs` (as `api_server_openai_routes` already
does with `_on_status`) and push `run.status` events: `{event: 'run.status', kind: 'lifecycle'|'warn'|'wait',
text, retry_in_s?, attempt?, max_attempts?}` — the same text the CLI shows (`_emit_status`, `_emit_diagnostic_wait`),
already free of secrets. Clients can then say "rate limited by the provider, retrying in 10 min (attempt 1 of 3)".

**Score side:** until this exists Score shows a no-progress notice after 60 s (PLAN follow-up); with it, Score shows the
status text and the retry countdown.
