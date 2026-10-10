# Brief: a reply that makes no progress says so (follow-up, owner 2026-10-09)

**Problem:** a turn on a rate-limited provider waits up to ~30 min inside Hermes (429 → "Retrying API call in 600s",
3 attempts) while Score shows an empty streaming reply with no explanation. The Runs API does not forward Hermes's
retry status (see `docs/proposals/hermes-run-status-events.md`).

**Do:**

1. Server: track the last progress per streaming reply (delta, tool event, thinking, approval). Expose it in the message
   (e.g. `progressAt` on streaming agent messages, contract §6) or via a stream event; no polling of Hermes beyond what
   exists today.
2. Web: when a streaming reply has had no progress for 60 s, show under it "Waiting for the model ({elapsed}). Hermes
   may be retrying after a rate limit or a provider error." with the existing Stop action next to it; update the elapsed
   time every 30 s; remove the notice on the next progress. Same notice on Now's working block tooltip if cheap.
3. When a run ends with Hermes's failure notice text ("Your request was not processed…") Score's reply shows "The model
   didn't answer (provider error or rate limit). Try again or switch model." instead of the raw text, and offers Retry.
4. Tests: server (progress tracking, restart keeps it sensible), web (notice appears at 60 s with fake timers, disappears
   on progress, failure text mapped), one e2e with the fake adapter (a scenario step that stalls) if the fake can stall
   cheaply.

**Constraints:** AGENTS.md; no new dependencies; contract doc + packages/contract together; no migration expected (if
needed use 0044). Don't commit to main.
