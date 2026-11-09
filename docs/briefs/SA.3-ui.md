# SA.3-ui — subagents on screen (brief)

Decisions 173–174; design `docs/briefs/SA-subagents.md`. The server and contract are done: read `docs/API-CONTRACT.md` section 19, and
`packages/contract/src/subagents.ts`. The approved mock-ups are **binding**: `docs/design/bold/mockups/24-subagents-chat.dc.html`,
`-jobmap`, `-phone`, `-start-job`, `-agent-settings`. Copy values from them, rebuild in React, never paste their HTML. Where this brief and a
mock-up differ, the mock-up wins and you report the difference. Mock-up data (names, numbers) is sample text, not fixtures.

## Parts

**1. Data** (`apps/web/src/bold/room/` or a new `apps/web/src/bold/subagents/`): a hook reading `GET /api/jobs/:jobId/subagents`, kept live from
the stream's `subagent.upserted` and `subagents.changed` events, following how the room reads jobs and exchanges. Limits come from `Job.subagents`
(`maxConcurrent: null` = the agent's own, from `GET /api/agents/:agentId/subagents`); `subagents.changed` updates the job's cached copy.

**2. Chat status card** (`-chat`, `-phone`). Under the agent's message for the turn that started them: "Subagents · 3 of 4 done", the rows
(Done green / Waiting amber "needs you" / Failed / Working, the goal, the time or cost), "Details" opening Watch for that run the way other
links to Watch do. The card is per agent in the current job; rows with `waitingOnYou` show "needs you". On a phone it collapses to one button with
`aria-expanded` as in `-phone`. Never show a subagent as a chat member, an author or an avatar.

**3. The job's line** (`-chat`, top section "Current job"): "lead is working · 3 of 4 subagents done · $0.42 of $5.00": add the subagent part
only when the job has rows.

**4. Approval card** (`-chat`): when `approval.fromSubagent` is true its heading reads "A subagent of {agent} wants to run this". Keep the card
protected and otherwise unchanged. Find every place an approval card renders in the new shell.

**5. `/subagents`** (`-chat`). The composer handles it itself and never posts it, like `/usage` and `/compress`. The slash menu offers
`/subagents 2` "At most 2 at once, for this job", `/subagents off` "None in this job", `/subagents on` "Back to the agent's limit (4)", and the
note "The agent's limit is the most you can set here. Change it in its settings." `/subagents` alone shows the state. Each calls
`PUT /api/jobs/:jobId/subagents` (`{ maxConcurrent: N, enabled: true }`, `{ enabled: false }`, `{ enabled: true, maxConcurrent: null }`) for the current job,
and shows a one-line note in the room as in `-phone` ("Subagents set to at most 2 for this job. Change"). A number above the agent's limit: the note
says the limit is lower, and nothing is sent. No current job: the note says to start one. An invalid argument: the note gives the usage.

**6. Context bar** (`ContextBar.tsx`, `-chat`, `-phone`): a button "Subagents: up to 4", "Subagents: 2" or "Subagents: off" beside the model, opening the
same three choices. Coding agents with `control: 'none'`: no button.

**7. Side panel** (`-chat`, the right column): the section "SUBAGENTS": At once, Used in this job "4 of 20", Their cost so far, "See what they did". Cost: the sum
of rows' `costUsd`, shown with "about"; where rows have tokens and no dollars, the tokens; nothing known: "—". Unknown is never $0.

**8. Job map** (`-jobmap`, `apps/web/src/bold/jobmap/`): one node, "4 subagents, 3 done", "lead's own helpers · up to 4 at once", with the selected panel
listing rows. This replaces the swarm layer **only for jobs with `Job.subagents` rows**: the swarm layer stays for old runs with helpers (see the design note's Migration), do
not delete it. The header's "6 of 20 subagents used". The "Held back by the limit" note can be left out: the server doesn't report it yet, say so in your report.

**9. Start a job** (`-start-job`, `BoldStartJob.tsx`, `start-job-*`). The helpers picker is replaced by "Subagents": Off, 1, 2, 3, 4 pills (the lead's limit from its settings
caps them), "Total in this job" number field (default 20), "then the job pauses and asks you". Voters stay a named-agent picker, with the mock-up's words. Send `subagents` on job
creation. **For an orchestration or workflow run**, `helpers.agentIds` is no longer set for new runs; keep `helpers.voters`. `votersOf` no longer falling back needs nothing on the web side.
Reading old runs with helpers stays as it is.

**10. Agent settings** (`-agent-settings`; `apps/web/src/bold/agent-more/`, a new `SubagentsCard.tsx`): for `control: 'limits'`, Allow subagents, At once, Model ("Same as {agent}"
when null), Steps for each, Time for each ("No limit" when null), Save, with the mock-up's text. For `on_off`: Allow subagents and "Claude Code decides how many run at once…". For `none`: "Subagents aren't supported here yet" and its text.
`PUT /api/agents/:agentId/subagents`.

**11. Pause at the total** already has its words and button through `ExchangeRequests`. Orchestrations pause with `subagent_total`: add an "Allow 10 more" that calls the limits
decision with `moreSubagents: 10`, beside the other budget pins.

## Rules
Follow AGENTS.md, including:
- **Design rules:** every new surface that asks the person to decide carries `data-protected` and joins the protected list (`styles/protected.css`, its test). New status displays don't need it.
  Tokens under `[data-ui='bold']`; class names prefixed `bold-`; theme tokens, not hard-coded colours (compare the existing CSS variables to the mock-up's values).
  A fixed or sticky element joins `KNOWN_OVERLAYS`.
- **Agents are identified by colour and shape, never colour alone**: use `AgentGlyph` where an agent appears.
- **Sizes:** tap targets at least 44px on a phone. No horizontal scroll at phone width. Respect the mock-up's phone layout.
- **File size and code map:** every file at or under 450 lines; `BoldStartJob.tsx`, `JobMap.tsx` are close, so put new parts in new files. New components are `PascalCase.tsx` with a named export of the same name, and their tests. Update `docs/CODEMAP.md`
  for every added or moved file.
- **Audit first:** note anything unused in the files you touch; remove only what you can prove unused, and list it with its proof in the report.
- TanStack Query and `apiFetch`, as the neighbours do; validate responses with the contract's schemas.
- Tests for every part: the states above, including off, unknown cost, no rows (nothing shown), over-limit `/subagents`, and that no subagent appears as a member. Add a fake-mode story for the UI: the fake port doesn't produce
  subagents, so test with fake responses, and don't change the server.

No new dependencies. Don't edit `docs/API-CONTRACT.md`, `docs/ARCHITECTURE.md` or anything under `apps/server`, `packages/contract` or `hermes-plugin`: if you need a change there, stop and report it. Don't commit.
Never run pkill/killall, never touch ports 8740/8741, never read ~/.hermes or ~/.score, never run real hermes/claude/codex, never use `SCORE_E2E_DEV=1` or git stash. Do not write to ~/score-workspaces.

## Checks you run
`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `node scripts/structure-check.mjs`. **No test runs and no e2e** (owner: no pre-fix checks). Call tools only through the tool interface, never as text.

## Report
The files changed, the checks' results, each part's state, every difference from a mock-up.
