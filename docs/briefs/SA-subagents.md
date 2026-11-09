# SA: subagents instead of named swarms (design note)

Owner, 2026-11-09: "we are just calling other agents in score which means we need to create plenty of agents to do the
swarm", "we need a command to limit or specifically telling it to spin or not", "on up to 4", "in a chatroom, agent can
still talk and hand over job to each other". Decision 173. Status: design, nothing built. A mock-up comes before any UI.

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
| Spending | The existing job budget (check 2) |

Why the two kinds: Hermes settings are per profile, and Score's run request passes a model, not settings, so a per-job limit
can't be handed to Hermes. The block message tells the model what happened ("the limit for this job is 2"), and its limit
is also in its instructions so it can plan. The prompt is never the only control. **If the block fails, fail closed for
`delegate_task`**: unlike Score's other hooks, which fail open so Score can't break an agent, this one is a limit.

## Subagents stay out of the room

A subagent must not speak in the chat, hand off or start exchanges: it reports to its parent, and its parent is the one on
the team. It inherits the parent's tools, which may include Score's (`score_reply` and the hand-off tools). The plugin's
`pre_tool_call` hook blocks those for a child session (check 4).

## Coding agents

Claude Code spawns its own subagents, and Score's parser already reads them (`subagent` events, `parent_tool_use_id`).
Codex's parser has no subagent handling.

- **Off for a job:** Score's Claude driver already passes `--disallowed-tools` at launch, so add the subagent tool.
- **Limits:** no count setting is known: the note's total-per-job rule may have to stop the job after the limit, not block.
- **Approvals:** these run under the tool's own permissions and Score's coding policy, not Hermes's cards.

All of this is check 5. The controls show only what a given agent's program can enforce, and say so.

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

1. **Block:** the plugin's `delegate_task` block really stops the subagents, for a whole batch, and the lead recovers.
2. **Spending (a small paid run; the owner's OK needed):** the code folds children's cost into the parent's session. Does
   it reach `runs.cost_usd`, and does the job budget stop in time? Fallback: sum child sessions by `parent_session_id`.
3. **Open chats:** what a session pinned to background does after the profile goes inline, and whether Score should start a
   fresh session for it.
4. **Score's tools in a child:** does a subagent get them, and does the block hold. Also why `score_reply` showed an error
   in two of the tests.
5. **Coding agents:** a test on Claude Code (off, Stop, spending, permissions), and what Codex does.
6. **After the Hermes update (H.1):** repeat the table above on the new version; the checks ran on the installed one.

## Build order

1. The checks above, then this note's review (Sonnet with an Opus advisor), findings answered here.
2. **Safety first:** inline on every profile (with the owner's OK), the Agents page warning, the child tool block. This fixes
   today's gap on its own and can ship by itself.
3. Limits: the agent ceiling, the policy, the count and block, `/subagents`.
4. The UI, from an approved mock-up: context bar, job map node, Start a job, recipe step, approval card's source.
5. Retire the helpers picker for new jobs; the owner removes the swarm profiles.

## Not doing

- Subagents voting (Score couldn't count). The `advanced-delegation` plugin's profile routes and model routes could give a
  subagent a named profile's model and permissions: read only, not installed or tested; a later option.
- Hermes's Bot Mode Group Chats: they overlap with Score's rooms.
