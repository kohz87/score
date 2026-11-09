# SA: subagents instead of named swarms (design note)

Owner, 2026-11-09: "we are just calling other agents in score which means we need to create plenty of agents to do the
swarm", "we need a command to limit or specifically telling it to spin or not", "on up to 4", "in a chatroom, agent can
still talk and hand over job to each other". Decision 173. Status: design, nothing built; the checks are in below. Mock-up approved 2026-11-09 (copies
`docs/design/bold/mockups/24-subagents-*.dc.html`): it is binding for the UI; where this note and the mock-up differ, the
mock-up wins and the difference is reported.

## The idea

Score treats two different things as one. **A team member** has an identity: a profile, memory and a chat; you talk to it.
**A subagent** is throwaway: its parent creates it for one narrow task, it reports back and it is gone. Today the swarm and
helpers (decision 150) need named profiles, so `swarm-1..3` sit in the chat list. From now on a named agent spins up its own
subagents, and parallelism no longer means creating profiles.

## What does not change

- **Chat rooms.** Agents still talk to each other, @mention each other and hand jobs over, through exchanges, exactly as
  today. A hand-off is about who does the work; subagents are about how one agent does its part.
- **Recipes** that give a step to a named agent.
- **Votes** go to named agents through Score's vote system, and Score does the count, so the lead can't bend the result.
  One `voter` per model is enough.
- **A locked-down helper** (a read-only auditor) stays a named agent: a subagent can't have fewer tools than its parent
  except for the fixed list below.
- **Old runs** keep rendering their swarm layer read-only.

## What was verified (2026-11-09, live on gem38, free model, installed Hermes 557254fa)

Seven runs through Score's own API, plus reading the code.

| Behaviour | `gateway_mode: auto` (default on API surfaces) | `gateway_mode: inline` |
| --- | --- | --- |
| Run | Ends in seconds, subagents still working | Stays open until they finish |
| Results | Never reach the lead: "the client owns the next model turn" | In the same turn |
| Stop | Nothing to stop; a subagent finished ~100 s after its run ended | Kills the running subagent (process gone, session closed) |
| A flagged command the guardian escalates | No card: the child gets `pending_approval`, reports "refused"; a `guardian_evaluating` row stays until it expires | Human card; a deny took effect (`decision_by: you`) |

- A flagged command the guardian approves runs, as it does for a parent.
- Each subagent starts with a fresh context, so voters would not share the lead's conversation; the same model may still
  agree with itself.
- Children get the parent's tools minus `delegate_task`, `clarify`, `memory`, `send_message`, `cronjob_manage` and kanban.
- Real agents have never called `delegate_task` through Score (no rows before the tests), so nothing has gone wrong yet.

**Not verified:** see "Checks before building".

## The core rule

**Every Hermes profile Score runs uses `delegation.gateway_mode: inline`.** Without it subagents are unsafe in Score: no
results, no Stop, no human approval. That is true today for any agent that happens to call `delegate_task`, so this is a
fix as well as a feature.

- Score sets it through the Hermes CLI (`hermes -p <profile> config set`, adapter boundary) when it creates or adopts a
  profile. Existing profiles: a one-time step, prepared and shown to the owner first (writes to the owner's real profiles).
- The mode is frozen per session, so a chat that is already open keeps its old mode. See check 3.
- The Agents page warns when a profile's mode isn't inline, as it does for other setup problems.

## Controls

Three levels, the most specific wins, and a lower level may only narrow:

| Level | Control | Enforced by |
| --- | --- | --- |
| **Agent settings** (the ceiling) | On or off; up to N at once; model; steps and time for each | Hermes config, for that profile |
| **Start a job, recipe step** | Off, or a lower N; total per job | Score |
| **Chat command** | `/subagents off`, `/subagents on`, `/subagents 2`; `/subagents` alone shows the current state | Score |

**Defaults (owner):** on, up to 4 at once. Lead's defaults, open to change: one level deep (Hermes's own default; subagents
can't spawn their own), the parent's model, and a total of 20 per job.

| Limit | How |
| --- | --- |
| On or off (agent) | The profile's `delegation` toolset |
| At once | `delegation.max_concurrent_children` (Hermes default 10: Score sets 4) |
| Depth | `delegation.max_spawn_depth` (default 1, kept) |
| Each one's steps and time | `delegation.max_iterations`, `child_timeout_seconds` |
| Model | `delegation.model` |
| Total per job, and job or chat limits below the ceiling | Score's policy file, enforced by the plugin's hook before anything starts (see "How the block works") |
| Spending | The job budget, best effort (see "Spending"); the count is the timely control |

Why the two kinds: Hermes settings are per profile, and Score's run request passes a model, not settings, so a per-job limit
can't be handed to Hermes. The block message tells the model what happened ("the limit for this job is 2"), and its limit
is also in its instructions so it can plan. The prompt is never the only control. **If the block fails, fail closed for
`delegate_task`**: unlike Score's other hooks, which fail open so Score can't break an agent, this one is a limit.

## Subagents stay out of the room

A subagent must not speak in the chat, hand off or start exchanges: it reports to its parent, and its parent is the one on
the team. It inherits the parent's tools, including all of Score's. **The hook blocks every tool Score provides in a child
session:** the plugin's own (`score_*`, `knowledge_*`) and the MCP route (`mcp_score_*`, `mcp__score__*`), by prefix and not
by a list of names, so `orch_*` and `score_approve` are covered and a capability pasted into a child's goal is useless.
Reading Knowledge can be allowed later if a real need shows up.

This stops ordinary tool use, not a determined script: a subagent with a terminal can do what its parent's terminal can.
That is the same same-user limit the parent has today, not a new hole. A locked-down helper stays a named agent.

## How the block works

Hermes makes `pre_tool_call` fail closed (`plugins_dispatch.py`): a timeout blocks the tool, and that callback is then
suppressed for 60 s. So a hook that calls Score could stall a whole profile. **The hook never touches the network.**

- **A second, separate callback**, not a change to `_make_hook`. It returns at once for any tool except `delegate_task` and
  Score's own. For those two it blocks on any exception of its own (fail closed); every other tool is unaffected.
- **The limit:** Score writes a small policy file per session (its limits, and how many it has counted so far) before each
  run and on `/subagents`. The hook reads it at the call, so a change applies to the next call and there is no stale cache.
  A Score session with no readable policy: `delegate_task` is blocked, saying why. A session Score didn't start (the owner's
  own terminal or Telegram) has no policy and is left alone: Score doesn't govern those.
- **The total:** the hook counts per session in process, under a lock, on top of the file's count, so one session can't pass
  it. Several agents in one job are reconciled by Score, which pauses the job and may overshoot by the few already started.
- **Telling a child apart:** an in-process set filled by `subagent_start`, which Hermes runs on the parent's thread before the
  child starts (no race, and no need to ask Score). Not by the shape of a session id.
- **Sessions still pinned to background** (check 3): `delegate_task` is blocked, with a message to start a new job.
- **Compression gives a session a new generated id** (found in review). The policy file is under the id Score started, so the
  guard walks `parent_session_id` up the profile's `state.db` (read-only, local) to find it. A row's `source: subagent` carries through a
  compression, so a compressed subagent stays one, also after a restart. `subagent_start` tells Score which session the job is known by.
- **All of this needs the updated plugin on the profile.** Rolling it out is a release step, with the owner's OK; Apply refuses (409) for a profile without the guard, and only changes settings.

## Coding agents

Tested 2026-11-09 on Claude Code 2.1.319 (Haiku, about 2 cents in all) and Codex 0.164 (`gpt-6-luna`).

**Claude Code**

| Point | Result |
| --- | --- |
| Shown in Score | Yes, already: the `Agent` call with a summary, child calls linked to it (`parent_call_id`) |
| Dollars | Yes: the run's `cost_usd` is filled, unlike Hermes runs |
| Off for a job | Works: `--disallowed-tools Agent,Task`, which Score's driver can add at launch |
| Stop | Works: cancelled in about a second mid-subagent, no process left |
| Permissions | A subagent stays under the agent's rules: its `python3` command was denied by the permission system |
| **Background subagents** | **A bug in Score today.** Claude Code may run a subagent in the background and then report a second result, and Score marks the run failed ("reported more than one result", `claude-parser.ts`). A foreground subagent completes normally. No real work has been hit yet |
| Count limit | None known. Total per job has to be counted by Score, which then stops the job: firm, but after the fact |

**Fix for the background bug (SA.1), tested:** Score launches Claude Code with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Same
prompt asking for a background subagent: 2 results by default, 1 with the variable, and the subagent still ran. The check
that rejects a second result stays: it stops a trailing result settling an attempt twice.

**Codex** (no live Codex agent in Score, so tested outside Score, read-only): it has `spawn_agent` and `wait_agent`
(`multi_agent` is stable and on). **`--disable multi_agent` did not remove them**, so "off" isn't solved. Its events show only
a `wait` with no receiver, so a real spawn couldn't be confirmed. Score's parser doesn't know `collab_tool_call` and treats an unknown item as invalid, so a Codex run
that uses subagents would be marked failed (from the code, not run through Score). Until these are answered, the Codex controls say "can't be enforced" and Score doesn't offer subagents as a feature there.

The controls show only what a given agent's program can enforce, and say so.

## What you see (from the approved mock-up)

At the job's total the job **pauses and asks** rather than stopping. Where a route records no dollars (a ChatGPT
subscription), the subagent rows show tokens instead of cost. The Agents page's setup card applies `inline` to the listed
profiles only when the person presses Apply.


- **Context bar:** "Subagents up to 4" next to the model; `/subagents` changes it.
- **Job map:** one node, "4 subagents, 3 done", replacing the swarm layer; details and nested calls stay in Watch.
- **Approval card:** names the source, "a subagent of builder", from the child's `hook_session_id`. Protected as today.
- **Start a job:** the helpers picker becomes the subagent setting; voters stay a named-agent picker.
- **Chat list:** nothing new. The swarm profiles can be removed by the owner once nothing refers to them (Score doesn't
  delete profiles by itself).

## Server and contract (lead)

- Contract first: a `subagents` policy (`enabled`, `maxConcurrent`, `maxTotal`) on jobs and recipe steps, and a route for the
  command. `docs/API-CONTRACT.md` updated in the same change.
- A count per job from `subagent_start`, which Score's plugin already forwards (Score's translator doesn't use it yet).
- `helpers.agents` stays readable for old runs and is no longer offered for new ones. `helpers.voters` stays.
- Scan and audit helpers (`startScan`, `autoAuditStep`): for the build to decide, once check 1 is known; a named read-only
  agent is the fallback.

## Checks before building

1. **Block (answered 2026-11-09, a temporary plugin on gem38, since removed):** a `pre_tool_call` hook returning
   `{"action": "block", "message": …}` works. A batch over the limit was stopped before anything started (no child sessions),
   and the lead read the message and reported it. In a child session `score_reply`, `rooms_post` and `score_handoff` were all
   blocked and no exchange was created. Child calls carry the child's own `session_id`, which is how the hook tells them apart.
   Hermes reloaded the plugin live and restarted only that profile's slot.
2. **Spending (answered 2026-11-09; one run on `openai/gpt-6-luna` through OpenRouter, under a cent).** Hermes recorded
   dollars on each session row ($0.0034 parent, $0.0022 and $0.0002 children). The parent's row doesn't include its
   children: the rollup is in memory only, each row holds its own calls, so the sum is the true total. **`runs.cost_usd`
   stayed null, and past Hermes runs show the same: Score's job budget sees "unknown spend" for every Hermes run, with or
   without subagents** (coding agents do report dollars). So this needs its own fix, before limits rely on it: sum the
   session row and its children by `parent_session_id` (`session_cost_snapshots` already holds child rows, on a ~15 minute
   sweep), or read `cost_usd` from the run stream's `subagent` events for a live figure. A ChatGPT-subscription route
   records no dollars at all ("included"), so a dollar limit can't apply there; tokens could.
3. **Open chats (answered 2026-11-09):** a session started under `auto` stays background after the profile goes inline
   (tested: "Subagent dispatched; awaiting completion"). New jobs get new sessions, so they are fine. In a session still
   pinned to background the plugin should block `delegate_task` with a message saying to start a new job, rather than run
   it unsafely. This depends on check 1.
4. **Score's tools in a child (answered 2026-11-09): a subagent has them:** `score_handoff`, `score_reply`, `rooms_post`,
   `orch_*`, `score_approve` and others, listed by a subagent itself. The block in "Subagents stay out of the room" is
   required. Whether it holds is part of check 1. Still to explain: why `score_reply` showed an error in the parent's runs; it takes a capability, which a plain chat has no
   reason to have, so it is probably only the model trying it. The tool's error is harmless, but costs a call.
5. **Coding agents (answered for Claude Code; Codex open):** see "Coding agents".
6. **After the Hermes update (H.1, open):** repeat the table above on the new version; the checks ran on the installed one.

## Build order

1. Done: the checks above, and the note's review.
2. **Safety first:** inline on every profile (with the owner's OK), the Agents page warning, the child tool block, the block
   in sessions still pinned to background. This fixes today's gap on its own and can ship by itself.
   **Real dollars in the job budget** for Hermes runs (check 2) goes with it: it's a gap with or without subagents.
   So does the Claude Code background bug.
3. Limits: the agent ceiling, the policy, the count and block, `/subagents`.
4. The UI, from an approved mock-up: context bar, job map node, Start a job, recipe step, approval card's source.
5. Retire the helpers picker for new jobs; the owner removes the swarm profiles.

## Spending

Three sources, and what each can do:
- **Live:** the run stream carries `subagent` events with `cost_usd` (`_SUBAGENT_EVENT_KEYS`). Score's Hermes translator
  doesn't read them yet; it should. That is the only figure in time for a limit during a turn.
- **At the end of a turn:** read the session row and its children by `parent_session_id` directly, not through the ~15 minute
  sweep.
- **Compression continuations are linked** (corrected while building SA.1; this note said they weren't): a continuation is a
  row with `parent_session_id`, as `recover.ts` already relies on, so the tree covers it. `budget.ts` keeps live spend provisional
  anyway. Still, a dollar limit on a Hermes job is best effort and the screen says "about"; **the count limit is the control
  that acts in time.**
- **`cost_status: unknown` rows say `0.0`** (found on gem38's free model: 31 of 35 rows). That isn't a price, so such a run is
  unknown, not $0, and a job with a dollar cap pauses and asks, as it does today. `included` (a subscription route) is $0, and
  its tokens are what's shown.

While a turn stays open under `inline`, its reservation stays held and its spend provisional: the safe direction, already
how `budget.ts` treats an open run. A batch over `max_concurrent_children` gets an error back, not a queue (from the code); the
lead sees it and asks for fewer. `child_timeout_seconds` is 0 (no cap) and `max_iterations` 250 by default: Score sets steps
for each to 50, as in the mock-up. While waiting the lead is silent, so the status card comes from those same events.

## Migration

`helpers` stays in the contract and the database, and old jobs, recipes and runs keep working as they are; `subagents` is
added beside it. New jobs from Start a job don't set `helpers.agentIds`, so:
- `votersOf` falls back to the helpers when no voters are named. Old rows keep that. For a new job, no voters means no votes.
- `startScan` and `autoAuditStep` only run with helpers, so new jobs skip them: the lead can do both with subagents.
- Reserve sizing (`helpers.maxConcurrent`) stays for helpers. Whether a lead's reserve should grow with its subagent limit is
  decided in SA.2, with `executor-create.ts` in hand.
- The swarm layer has code in eight files under `jobmap/` (model, CSS, fixtures). It stays for old runs; the new node is added
  beside it.

## Review log

Sonnet with an Opus advisor, 2026-11-09, asked to break the design. Each finding was checked against the code; none rejected.

| Finding | Answer |
| --- | --- |
| P1: a per-job limit can't reach the plugin at call time; a call to Score could stall a profile | "How the block works": a local policy file and a separate callback |
| P1: the room-tool block was a name list and missed the MCP route; a capability can be pasted into a goal | Block by prefix, every Score tool |
| P2: telling a child by session id races | In-process set from `subagent_start` |
| P2: `inline` accounting and capacity weren't stated | "Spending" |
| P2: summing by `parent_session_id` misses continuations; the sweep is too slow | "Spending": live events, and the count as the timely control |
| P2: `votersOf`, scan and audit, reserve sizing | "Migration" |
| P2: accepting a later result reopens a real check | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, tested; the check stays |

**Build review of the server half (Sonnet with Opus advisor, 2026-11-09; 10 findings, verified).** Fixed: compression escaping the limits
and a compressed child regaining Score's tools; `tasks` sent as a JSON string counting as one; `inline` trusted for a session Score never ran, or a profile turned back to
`auto`; a missing policy on an outside continuation (the run doesn't start now); one failed file stopping a job's other sessions; the guard registered inside the sender's
`try`; the second plugin folder spelling; a room's own thread keeping a lifetime count (its count starts again at each request from the person, and the guard's own count follows a lower figure); a replayed
start counting twice; `action` in capitals; a child's wrong refusal message; a model name read as an option. Found by the lead while checking: the read allow-list in `cli.ts` lacked the new keys, so
every read would have come back unavailable and Apply would have looked as if it did nothing. Rejected: `used == total` pausing at the next agent turn (decision 174 says reaching the total pauses); a failed
spawn burning the guard's own count (Score's figure takes over, and it errs safe; the person can allow more); closing a concurrent run's subagents (a coding agent has one turn at a time); a late stop after the 5 s sweep (Hermes
fires it before the parent ends); the cost landing after a hop in a capped job (no worse than today); `knowledge_` matching a third-party tool in a child (fails safe, and the design chose prefixes); checking the plugin is loaded, not just present (a plugin change restarts the slot at release).

**Post-fix review (Codex `gpt-6.1-terra` at `max`, 2026-11-09; 20 findings, each verified).** Fixed: a new profile's pinned plugin without the guard; a failed policy write (the run doesn't start, and the stale file goes); a refresh upgrading a background session (a session's mode is now stored and only ever goes down); a lineage too long to follow (refused); one message to two agents starting the count twice; a reply with its usage missing read as free (`api_call_count`); a session that began seconds before Score's first run in it (2 s, not 60); a compressed child's stop; a pause with no way forward at the cap or when turned off; an orchestration's allowance not published; the card attaching to an approval; a failed read hiding rows after a reconnect; focus and errors in the context menu; the room's own thread having no control. Rejected, with reasons: the total passed after a gateway restart in the moment before a start event arrives (the children die with the gateway and the plugin's spool delivers the event; the overshoot is one batch, as this note accepts); **at once being per `delegate_task` call and per agent, not per job** (recorded as how it works: two agents in a job each have their own); the Hermes update's test run having no session id (a fixed prompt, no delegation); Apply stopping part-way across agents (each agent's own change is complete and in the safe order, and the card shows the state); fencing running work when a tightening can't be written (a disk failure: the stale file is removed instead); a slow guard stalling every tool (Hermes' hook timeout is 30 s, the read gives up at 0.2 s); settings not protected from themes (they ask nothing of the person, and the model control beside them isn't either). Deferred: reports reading `unknown` as $0 (older than this work, its own change: unknown figures would change on the Reports page); a compressed child's approval attribution and continuation cost (rare at 50 steps; it shows as its parent's and undercounts).

## Not doing

- Subagents voting (Score couldn't count). The `advanced-delegation` plugin's profile routes and model routes could give a
  subagent a named profile's model and permissions: read only, not installed or tested; a later option.
- Hermes's Bot Mode Group Chats: they overlap with Score's rooms.
