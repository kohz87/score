# PLAN.md audit against TASKLOG / CHANGELOG (2026-10-19, read-only)

Scope: every bold plan item without a tick (123 items: 1.x 20, 2.x 20, 3.x 14, 4.x 6, 5.x 36, 6.x 5, 7.x 5, 8.x 9, 9.x 6, 10.1, T1).
Result: 121 done, 1 partly done, 0 not done, 0 superseded, 1 blocked.
"TL" = docs/TASKLOG.md row dated that day. Version = CHANGELOG release that first shipped it.

## 1. Table

| item | verdict | evidence | note |
|---|---|---|---|
| 1.1 Contract package | done | TL 2026-10-06; packages/contract/src/index.ts | |
| 1.2 Server skeleton + pairing | done | TL 10-06; apps/server/src/app.ts | |
| 1.3 score.db + migrations | done | TL 10-06; apps/server/migrations/ (0001 to 0078) | |
| 1.4a Ingest path | done | TL 10-06 (3 rounds + adversarial review) | |
| 1.4b /api/stream + fence | done | TL 10-06; apps/server/src/hub/ | |
| 1.4c Ingest-key retirement | done | TL 10-06 | |
| 1.5 HermesPort + fake adapter | done | TL 10-06; apps/server/src/hermes/fake | |
| 1.6 Web shell | done | TL 10-06; apps/web/src | |
| 1.7 useStream per-query resync | done | TL 10-07 | |
| 1.8 AgentGlyph | done | TL 10-07 | later reworked by 10.2 / 10.8 |
| 1.9a SQLite readers + checkpoints | done | TL 10-07 | |
| 1.9b Session reconciliation | done | TL 10-07 | |
| 1.10 Upstream SSE client | done | TL 10-07 | |
| 1.11a Gateway runs | done | TL 10-07; apps/server/src/hermes/live | |
| 1.11b Fingerprint gate | done | TL 10-07; 5.6 builds on it | |
| 1.13a Bridge plugin | done | TL 10-07; hermes-plugin/score_bridge/ | |
| 1.13b Gateway approvals | done | TL 10-07 | |
| 1.13c Kanban denials view-only | done | TL 10-07; apps/server/src/domain/kanban-denials.ts | |
| 1.14a Bridge server | done | TL 10-07; apps/server/src/hermes/bridge/ | |
| 1.14b Approvals ledger + outbox | done | TL 10-07; domain/approval-store.ts, approval-outbox.ts | |
| 2.1 Rooms + messages store/API | done | TL 10-08; domain/rooms.ts | |
| 2.2 Mention + slash parser | done | TL 10-08; domain/parse.ts | |
| 2.3 Routing engine | done | TL 10-08 (2.3 + 2.4); domain/routing.ts | |
| 2.4 Message streaming | done | TL 10-08 | |
| 2.5 Chat UI | done | TL 10-08; web routes/chat | |
| 2.6 Composer | done | TL 10-08 wave 3 | |
| 2.7 Inline approval + plan card | done | TL 10-08 wave 4; domain/plan.ts | |
| 2.8 Chat side panels | done | TL 10-08 wave 4; domain/room-panels.ts | |
| 2.9 Tasks API | done | TL 10-08 (2.9 + 2.10); domain/tasks.ts | |
| 2.10 Steps model | done | TL 10-08; domain/steps.ts | |
| 2.11 Tasks board UI | done | TL 10-08; web routes/tasks | |
| 2.12 Task drawer | done | TL 10-08 wave 3 | |
| 2.13 Profiles reader | done | TL 10-08; domain/profiles.ts | |
| 2.14 Team overview UI | done | TL 10-08; web routes/team | |
| 2.15 SOUL/AGENTS editor | done | TL 10-08 wave 3 | |
| 2.16 Model, skills, memory, tools | done | TL 10-08 wave 4 | |
| 2.17 Routines | done | TL 10-08 wave 3 | |
| 2.18 Permissions + team rules | done | TL 10-08 wave 5; domain/team-rules.ts | |
| 2.19 Settings providers + connections | done | TL 10-08 wave 4 | |
| 2.20 Settings advanced config | done | TL 10-08 wave 5 | |
| 3.1 Lanes + hand-offs builder | done | TL 10-08 (Phase 3); domain/lanes.ts | |
| 3.2 Score timeline UI | done | TL 10-08 (3.2+3.3 merged); web routes/now | |
| 3.3 Now page cards | done | TL 10-08 | |
| 3.4 Briefs model | done | TL 10-08; domain/briefs.ts | |
| 3.5 Flow auto-layout | done | TL 10-08 | |
| 3.6 Flow canvas | done | TL 10-08 | |
| 3.7 Flow inspector + log + stats | done | TL 10-08 (finished on Codex) | |
| 3.8 Reports aggregations | done | TL 10-08; domain/reports.ts | |
| 3.9 Stacked bar chart | done | TL 10-08 | |
| 3.10 Time-split bars + tables | done | TL 10-08; web routes/reports | |
| 3.11 CSV export | done | TL 10-08; domain/reports-csv.ts | |
| 3.12 Profile management | done | TL 10-08 "Phase 3 complete" + live check on scoretestc; git a11294a6 | |
| 3.13 Remote access mode | done | TL 10-08; later 5.18/5.22 (HTTPS, Tailscale) | |
| 3.14 Visual QA pass | done | TL 10-08 | |
| 4.1 Frame capture | done | TL 10-08; domain/watch-frames.ts | |
| 4.2 Diff builder | done | TL 10-08; domain/watch-diff.ts, line-diff.ts | |
| 4.3 Media store | done | TL 10-08 (migration 0018 media) | |
| 4.4 Watch UI panes | done | TL 10-08 live-check row; git 303ac738; web routes/watch | |
| 4.5 Scrub timeline | done | same merge 303ac738 (tasks 4.4-4.6) | |
| 4.6 What she's doing + Other screens | done | same merge 303ac738 | |
| 5.1 Packaging | done | git baaf8965; scripts/start.mjs, scripts/score, docs/score.service.example | |
| 5.2 Accessibility audit | done | git 710d48ac; TL 10-08 row lists 5.2 merged | |
| 5.3 Performance | done | git dd99fab1; scripts/load-test.ts, scripts/perf/web-perf.spec.ts; TL 5.7 row (8 budgets) | |
| 5.4 Hermes upgrade drill | done | git e31db194; scripts/hermes-drill-facts.py | no own TL row, TL 10-08 lists it merged |
| 5.5 Docs | done | git ddc46687; README.md, docs/USER-GUIDE.md | |
| 5.6 Verify a new Hermes version | done | TL 10-08 | |
| 5.7 Stream batching | done | TL 10-08 | |
| 5.8 Channels + History tabs | done | TL 10-08 | |
| 5.9 Plugins and look + New task | done | TL 10-08 | |
| 5.10 Sign in from the browser | done | TL 10-08; git e775a227 | |
| 5.11 Model picker | done | TL 10-08 | |
| 5.12 Attachments to agents | done | TL 10-08 (5.12-5.16 row); domain/attachment-input.ts | |
| 5.13 Pause covers new tasks | done | TL 10-08 same row; domain/holds.ts, team-pause.ts | |
| 5.14 Plan start survives restart | done | TL 10-08 same row; domain/plan.ts | |
| 5.15 Spend per day | done | TL 10-08 same row; domain/spend.ts | |
| 5.16 Recover expired runs' results | done | TL 10-08 same row | |
| 5.17a Kanban attempts as runs | done | TL 10-09 (stage 1, 2a, 2b merged; flag ON live); domain/kanban-attempts.ts; web routes/attempts | plan text still says "design v3 pending" (stale) |
| 5.17b Kanban Stop | blocked | PLAN line + proposal docs/proposals/hermes-attempt-fenced-stop.md; Stop returns 501 for kr_ ids (TL 10-09 stage 2a) | upstream Hermes op missing |
| 5.18 HTTPS-only remote | done | TL 10-09 | |
| 5.19 Owner feedback round 1 | done | TL 10-09 | |
| 5.20 Owner feedback round 2 | done | TL 10-09 | |
| 5.21 Reports instant ranges + custom | done | TL 10-09 | |
| 5.22 Tailscale certificates | done | TL 10-09 | |
| 5.23 Responsiveness + save feedback | done | TL 10-09 | |
| 5.24 Chat message actions | done | TL 10-09 | |
| 5.25 Chat (hermes-webui) | done | TL 10-09 | |
| 5.26 Conversations | done | TL 10-09; domain/room-projects.ts | |
| 5.27 Workspace and agents | done | TL 10-09 | |
| 5.28 Phone (PWA) | done | TL 10-09; git "5.28 phone"; scripts/make-pwa-icons.mjs | |
| 5.29 Small wins | done | TL 10-09 | |
| 5.30 Documents | done | git 86f45e40; TL 10-09 | |
| 5.31 Model settings | done | git ec6e77f3; domain/model-aliases.ts | |
| 5.32 Profile import | done | git 9975c100; domain/profile-imports.ts | |
| 5.33 Rewind a conversation | done | git 7f1bf718; domain/room-rewinding.ts; TL 10-09 live check | |
| 5.38 Writing pass | done | TL 10-11; docs/WRITING.md; git 7f0d673b, 72163f79 | plan says "Done" in text, no tick |
| 5.39 Live feel | done | TL 10-11; git 089ef79a | |
| 6.1 Workspace | done | TL 10-09 | |
| 6.2 Knowledge server | done | TL 10-09; apps/server/src/knowledge/ | |
| 6.3 Knowledge web | done | TL 10-09; web routes/knowledge | |
| 6.4 Agent knowledge tools | done | TL 10-09 | |
| 6.5 Knowledge editor | done | TL 10-10 | |
| 7.1 Workflow builder | done | TL 10-10 (7.1a engine, 7.1b UI live; 7.1c per DECISIONS 47); domain/workflows/ ; web routes/workflows | |
| 7.2 Coding agents as team members | partly done | TL 10-10 merged; apps/server/src/runtimes/coding/ | OpenCode driver has `supported: false` (not installed, no recorded stream); Claude Code, Codex, and (7.6, TL 10-11) Antigravity work |
| 7.3 Web terminal | done | TL 10-10; web routes/terminal | |
| 7.5 Orchestrator | done | TL 10-10 (first live orchestration succeeded); domain/orchestration/ | |
| 7.7 Coding agents as workers | done | TL 10-13 (7.7a, v1.1.0), 10-14 (7.7b v1.2.0, 7.7c v1.3.0) | "Until then ... refuse coding agents" is stale |
| 8.1 CLI quota meters | done | TL Phase 8 (2026-10-16); v1.4.0 | |
| 8.2 Memory notes from compaction | done | TL Phase 8; v1.4.0; apps/server/src/knowledge/memory-notes.ts | |
| 8.3 Theme packs | done | TL Phase 8; v1.4.0; later made built-in themes by 9.2 | |
| 8.4 Chat-first user view | done | TL Phase 8; v1.4.0; web routes/user | |
| 8.5 Model picker for coding agents | done | TL Phase 8; v1.4.0 | |
| 8.6 Quota guard | done | TL 2026-10-17; v1.5.0 | |
| 8.7 Coding agents' sub-agents | done | TL 10-17; v1.6.0 | |
| 8.8 Role and personality | done | TL 10-17; v1.6.0 | |
| 8.9 Agent page cleanup | done | TL 2026-10-18; v1.6.1 | |
| 9.1 Theme storage, API, import/export | done | TL 10-17 (9.1 + 9.2); v1.6.0; migration 0071 | |
| 9.2 Theme engine and safety | done | TL 10-17; v1.6.0 | |
| 9.3 Layout model | done | TL 10-18; v1.7.0 | |
| 9.4 Customizer | done | TL 10-18; v1.8.0; web routes/customizer | |
| 9.5 Built-in themes + guide | done | TL 10-18; v1.8.0; docs/THEMES.md | |
| 9.6 Phase gate | done | docs/reviews/2026-10-18-phase9-gate + regate 1 to 4 (Codex max); TL "Phase 9 gate fixes G1-G3", decision 101; v1.8.0 | |
| 10.1 Settings as pages | done | TL 2026-10-19 line 395; v1.9.0; git c4592e18 | |
| T1 Fix load-flaky tests | done | TL 10-18 "T1 flaky tests merged"; v1.7.0/1.8.0 era | |

## 2. Not done, partly done, blocked

- **Not done:** none.
- **Partly done: 7.2** Coding agents as team members. Claude Code, Codex and Antigravity run. OpenCode is listed but its driver is `supported: false` (apps/server/src/runtimes/coding/opencode.ts). Remains: install OpenCode, record an event stream, add tested versions, switch the driver on (or drop OpenCode from the plan text).
- **Blocked: 5.17b** Kanban Stop. Needs an upstream Hermes attempt-fenced stop operation. Checked 2026-10-19: installed Hermes e97923c has only reclaim/block; the proposal is an unsent draft. Until then Score says Stop is unavailable for Kanban attempts (501 for `kr_` ids).

## 3. Plan text that conflicts with later decisions or is stale

- Plan header and the Owner labels (Lead/Codex) describe Codex CLI as the implementer. Owner 2026-10-08 ("don't use Codex for implementation any more") moved implementation to Sonnet agents, Haiku monitors (decision 99); Codex is audit-only.
- 5.17a still says "design v3 pending"; it merged as v5.1 with stages 1, 2a, 2b (TL 2026-10-09).
- 7.7 says orchestrations and workflows refuse coding agents "until then"; 7.7a to 7.7c (v1.1.0 to v1.3.0) lifted that (Antigravity and OpenCode remain refused in workflows).
- 8.3 says "built-in themes (3 to 4) ... side navigation vs top navigation" with design first; 9.x replaced it with the full theme system and 9.2 turned the 8.3 packs into built-in themes (not a conflict, but 8.3 is now a subset of 9).
- 8.4 "optionally guarded by the security password" and "Not planned: multiple user accounts" are consistent; no conflict.
- Phase 7 lists 7.4 (done), 7.5, 7.7 but has no bold line for 7.6 Antigravity (done per TL 10-11 and CHANGELOG); 7.1c only appears in DECISIONS 47 and the TL, not in the plan.
- 5.38 text says "Done." and 6.5 sits after 7.x in the file; neither carries a tick, so tooling that relies on the tick will misreport them. Items 1.x to 9.x mostly lack ticks by design (only phase 10 uses them).
