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
