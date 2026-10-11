# Decisions taken by the lead on the owner's behalf

The owner (2026-10-10): "you have my permission to proceed everything with your recommendation and tasks while I'm away,
I just need you to maintain a list of those that you have decided and apply at the end of the day."
Each entry: what was decided, why, and how to undo it. Reviewed with the owner at the end of the day; anything the owner
rejects is reverted or changed then.

## 2026-10-10

| # | Decision | Why | Undo |
|---|---|---|---|
| 1 | Test profiles `scoretesta`/`scoretestb` use `gpt-6-luna` (ChatGPT/Codex), not a free model (owner asked "luna"; picked the newest Luna) | free model hit HTTP 429 | Team › agent › Model |
| 2 | Restarted `hermes-gateway.service` once (all agents idle) so Hermes saw the new orchestrator MCP tools | owner permission; Hermes caches MCP tool lists | — |
| 3 | `duck@0.1.12` (licence "BSD", variant unnamed) added to licence exceptions together with the owner-approved `pako` | transitive dependency of `mammoth` (Word text) | remove `mammoth` + both exceptions; Word files then stored without text |
| 4 | Chat versions (5.35): older branches are **read-only**; no "continue from an older version" | Hermes session memory was rewound; branching it needs Hermes support | — (later feature) |
| 5 | Knowledge files (6.6): documents ≤ 10 MB get git history, larger ones stored without it; 25 MB per file; zip limits 1,000 entries / 200 MB / 100:1 | keep the vault's git small; zip-bomb safety | change the limits in Settings › Knowledge later |
| 6 | Knowledge files: "Also save to Knowledge" in Chat is **off by default**, default folder `inbox/` | owner wanted a choice each time | flip default |
| 7 | 7.1 workflow builder design **approved by the lead** at v8.3 after 8 Codex rounds (last verdict "substantially sound"); Codex reviews the implementation before merge | design converged; remaining items were executor fixes now done (H, I, J) | — |
| 8 | Workflows default to **gates-only** approval (only gate nodes stop for you); "approve every step" available per run | a drawn workflow already shows its steps; per-step approval is opt-in | start dialog option |
| 9 | Responsive pass (5.34): tablet Chat uses the conversations drawer, not two side-by-side panes; phone Pause everyone is icon-only with a tooltip | simpler, consistent with phone | follow-up task |
| 10 | Orchestrator live runs on Luna: unknown/no-cost runs show spend as "not settled"; no budget set on test runs | Hermes reports tokens, not complete costs | — |
| 11 | Chat versions: your own message's `‹ n / count ›` sits right-aligned under the bubble with the arrows outermost; Score has no "regenerate", so agent replies get no version arrows | matches ChatGPT; Retry keeps the first reply | CSS in chat.css |
| 12 | Workflow runs get their own API (`/api/workflow-runs`) and don't appear in the orchestrations list | the orchestration pages assume a lead agent | — |
| 13 | Orchestrations: after 20 Hermes refusals a step fails (`hermes_refused`) and the lead decides; workflows ask you ("Try again / Stop") | no new decision type for orchestrations | — |
| 14 | Database: the orchestrations table is rebuilt so workflows have no lead (rejected the builder's "placeholder lead" idea) | a fake lead could trigger lead-only logic (pauses, remaps) | — |
| 15 | Known flaky e2e tests (chat.spec after rewind specs, chat-formatting Copy/Stop, coding-runtime under load) are fixed in one follow-up batch, not per feature | they fail identically on main | — |
| 16 | Knowledge files live; plugin copies on `default` and `scoretesta` updated (tool descriptions only); Hermes **not** restarted for it — agents see the new descriptions after the next gateway restart, document search already works | avoid an unneeded restart of your real agent | restart `hermes-gateway.service` when convenient |
| 17 | Live check wrote a test PDF into your Knowledge vault (`score-live-check/`) and deleted it; the vault's git history keeps the add + delete commits | prove upload → extraction → search on the real vault | — |
| 18 | Knowledge: `.txt` uploads become notes (`.md`); XLSX isn't offered "Save to Knowledge" (no spreadsheet text extraction yet) | notes are Markdown; no approved XLSX library | later task |
| 19 | `coding-runtime.test.ts` gets a 30 s per-test timeout (each test spawns real CLI processes; 4 other files already do this) | no way to cut the spawn count; root cause is real process start-up under load | — |
| 20 | The "visual.spec fails once after a rebuild" flake couldn't be reproduced (3 fresh-build runs, a CPU-hog run, 2 full runs); nothing changed for it | a blind fix would be a guess | revisit if it recurs |
| 21 | Before deploying migration 0051 (rebuilds the orchestrations table) I ran it on a copy of your live database (deleted afterwards) and kept a backup: `~/.score/backups/score-pre-0051-2026-10-10.db` | the migration rewrites a table that holds your orchestration history | restore with `scripts/score restore` if ever needed; delete the backup when happy |
| 22 | 7.1a merged after Codex's code review (2 high, 8 medium), a verification round (1 high, 3 medium) and the fixes for all of them; not a third Codex round | each round's remaining items were edge cases with failing-first tests; e2e 216/216 | — |
| 23 | **Incident:** the 7.1b builder ran `pkill -f start.mjs` (against the project rule) and stopped your live Score for about a minute; it restarted it with the correct live settings. Checked afterwards: no fence, no orchestration/agent runs or replies were in flight, no errors. Every builder brief now forbids `pkill`/`killall` and touching ports 8740/8741 explicitly | — | — |
| 24 | Ran one live workflow on the test profiles (Luna): `scoretestb` writes a haiku → gate (I approved) → `scoretesta` reviews → end; succeeded in ~1 min. The workflow "Live check: haiku with review" stays in Flow › Workflows as an example | same pattern as the approved first orchestration; proves 7.1 end to end | delete it in Flow › Workflows (it's "used", so delete its runs first or keep it) |
| 25 | Docs: README gets Workflows screenshots, and USER-GUIDE.md gets sections for Knowledge files, Orchestrations, Workflows, Coding agents, Terminal and chat versions | the guide was missing everything from Phase 6–7 | — |
| 26 | **Your call:** two dev-only packages licensed MIT-0 (`@csstools/color-helpers@6.1.2`, `@csstools/css-syntax-patches-for-csstree@1.1.15`, pulled in by the test DOM `jsdom`; never shipped) are listed in `license-exceptions.json` as "pending owner review" now that the checker matches AGENTS.md exactly | MIT-0 is MIT without the attribution clause, but it isn't on the list | approve them, or I replace/pin around jsdom |
| 27 | Phase 7 gate: fixed all 7 findings (fix batch L) and closed the gate without a second Codex max pass; the Gemini whole-repo review remains yours to run when you like | each fix has a failing-first test; earlier rounds' pattern | run a Codex verification later if you want |
| 28 | Knowledge export: the browser holds the finished zip in memory before saving (the safety header rules out a plain form download), so exports near the 1 GB limit need a lot of browser memory; folders export from the Files header (no per-row button); agents get no export tool | simplest safe design; your vault is far smaller today | lower the limit or add a one-time download link later |
| 29 | Knowledge editor (6.8): read your "can we not use preview" as **drop the Preview/Edit/Split switch** — notes open in the live editor; a small "Source" toggle stays for raw Markdown | the live editor already shows the formatted result | — |
| 30 | Embedded note images: downscaled in the browser to 1,600 px, ≤ 1.5 MB each, PNG/JPEG/GIF/WebP only (no SVG); note limit raised from 2 MB to 8 MB; agents read `[image: name, size]` placeholders and can't add embedded images | keeps notes, git history and agent context small; SVG can carry scripts | change limits later; uploaded files remain for big images |
| 31 | Note images have no width presets (25/50/100 %): any width syntax would be non-standard Markdown, so images fit the editor width | keeps notes portable Markdown | add later with an agreed syntax |
| 32 | When an agent rewrites a note it saw with `[image: …]` placeholders, kept placeholders are turned back into the original images; a dropped placeholder deletes that image | agents can't see or re-send image data, so this keeps your images safe through agent edits | — |
