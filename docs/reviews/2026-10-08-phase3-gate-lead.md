# Phase 3 gate review (lead, 2026-10-08)

The owner asked the lead to review all code itself ("review the code yourself"). Scope: every Phase 3 task (3.1–3.14),
reviewed line by line at integration, plus a sweep of the merged result. **Verdict: pass.** Everything found was fixed
before or during integration; open items are listed at the end.

## Sweep of the merged code
- **Mutations:** every new mutating route has the human guard and idempotency receipts: brief pause/resume, node stop,
  plan start, team pause/resume, permission override delete, agent create/patch/delete/preview, media upload, and
  browser revoke (added by the lead).
- **Hermes boundary:** Hermes identifiers stay in `apps/server/src/hermes/`, and `kanban.db`/`state.db` are read only
  through `openReadOnly`. No new process spawn outside the CLI runner, and it only spawns `execFile` with argv arrays.
- **Untrusted agent text:**
  - plan steps resolve @mentions only to known agents, and titles are capped at 300 characters before reaching the
    Kanban create path (`--` separator);
  - brief titles are redacted and capped;
  - the reply streams are held back until settled (Phase 2 gate fix).
- **Web:** no new raw HTML. The only new dynamic link is the same-origin CSV download.

## Findings fixed during integration
| Task | Finding | Fix |
|---|---|---|
| 3.1 | `/api/now` read every run and every message hop ever | bounded to the window's runs and Made today's tasks |
| 3.2 | Timeline window 3.5 h vs the design's 1.5 h (truncated labels, crowded connectors); pause detected from headline text | design window and quarter-hour ticks; short blocks grow to fit labels; `paused` in the contract |
| 3.4 | Migration number gap (0016 with 0014/0015 unused) | renumbered |
| 3.6/3.7 | Flow review edges re-read the whole Kanban history every poll | derived from tailed events plus a one-time backfill of newly linked tasks |
| 3.7 | Flow notice missing; inspector description clipped | `notice` added to the contract; layout fixed |
| 3.8 | Report definitions guessed (updatedAt as finish time, no reviewer data) | exact definitions from Kanban history, recorded in contract §9 |
| 3.10 | "n/a, reviews" for everyone; empty demo | role-aware copy; deterministic 30-day fake history |
| 3.12 | Settings and danger zone above the design's overview; loopback-only after remote access existed | moved below; allowed on loopback or TLS remote, refused on plain-HTTP remote |
| 3.13 | Browser list/revoke unguarded in local mode; unpaired bookmarks got a JSON error | human guard; public app shell for in-app paths |
| 3.14 | `shell.css` conflict with 3.13's banner; remote e2e needed a pre-built web app | merged; the spec builds when `dist` is missing |
| 3.x e2e | A leaked `page.route` errored a worker and skipped a random test; ambiguous Flow heading | `unrouteAll`; `.first()` |

## Open items (tracked, not blocking)
- Agent creation is untested against a live Hermes. The bridge install URL (`SCORE_BRIDGE_INSTALL_URL`, file or https,
  plus a pinned ref) needs a live check on a throwaway test profile.
- The agent's API key passes through argv while `hermes config set` runs, so it is briefly visible in the process list.
  That is acceptable on a single-user machine; documented.
- Image attachments are stored and shown, but not forwarded to agents (no vision hand-off yet).
- `flow.spec` depends on the demo scenario's timing; move it to a fixed fixture in Phase 5.
