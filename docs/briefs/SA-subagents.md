# SA: subagents instead of named swarms (design note)

Owner, 2026-11-09: "we are just calling other agents in score which means we need to create plenty of agents to do the
swarm", "we need a command to limit or specifically telling it to spin or not", "on up to 4", "in a chatroom, agent can
still talk and hand over job to each other". Decision 173. Status: design, nothing built; the checks are in below. A mock-up comes before any UI.

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
| Total per job, and job or chat limits below the ceiling | Score: the plugin's `pre_tool_call` hook sees `delegate_task` and its `tasks` before anything starts, and can return `{"action": "block", "message": …}` |
| Spending | The job budget, once it can see Hermes dollars at all (check 2) |

Why the two kinds: Hermes settings are per profile, and Score's run request passes a model, not settings, so a per-job limit
can't be handed to Hermes. The block message tells the model what happened ("the limit for this job is 2"), and its limit
is also in its instructions so it can plan. The prompt is never the only control. **If the block fails, fail closed for
`delegate_task`**: unlike Score's other hooks, which fail open so Score can't break an agent, this one is a limit.

## Subagents stay out of the room

A subagent must not speak in the chat, hand off or start exchanges: it reports to its parent, and its parent is the one on
the team. It inherits the parent's tools, which may include Score's (`score_reply` and the hand-off tools). The plugin's
`pre_tool_call` hook blocks those for a child session (check 4).

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

**Fix for the background bug (SA.1):** make Claude Code run subagents in the foreground, or accept a later result. To be
decided at build time, from what the CLI offers; the check that rejects a second result exists for a reason (7.7a), so it
is not simply removed.

**Codex** (no live Codex agent in Score, so tested outside Score, read-only): it has `spawn_agent` and `wait_agent`
(`multi_agent` is stable and on). **`--disable multi_agent` did not remove them**, so "off" isn't solved. Its events show only
a `wait` with no receiver, so a real spawn couldn't be confirmed. Score's parser doesn't know `collab_tool_call` and treats an unknown item as invalid, so a Codex run
that uses subagents would be marked failed (from the code, not run through Score). Until these are answered, the Codex controls say "can't be enforced" and Score doesn't offer subagents as a feature there.

The controls show only what a given agent's program can enforce, and say so.

## What you see

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

1. The checks above, then this note's review (Sonnet with an Opus advisor), findings answered here.
2. **Safety first:** inline on every profile (with the owner's OK), the Agents page warning, the child tool block, the block
   in sessions still pinned to background. This fixes today's gap on its own and can ship by itself.
   **Real dollars in the job budget** for Hermes runs (check 2) goes with it: it's a gap with or without subagents.
   So does the Claude Code background bug.
3. Limits: the agent ceiling, the policy, the count and block, `/subagents`.
4. The UI, from an approved mock-up: context bar, job map node, Start a job, recipe step, approval card's source.
5. Retire the helpers picker for new jobs; the owner removes the swarm profiles.

## Not doing

- Subagents voting (Score couldn't count). The `advanced-delegation` plugin's profile routes and model routes could give a
  subagent a named profile's model and permissions: read only, not installed or tested; a later option.
- Hermes's Bot Mode Group Chats: they overlap with Score's rooms.
