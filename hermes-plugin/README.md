# Score bridge

`score_bridge` is a Hermes plugin with no runtime dependencies. It observes hooks and sends
redacted activity to Score. It does not apply approval decisions or Kanban grants; those are
separate tasks (1.13b/c).

## Install in a profile

Python 3.12 or newer is required; the plugin uses POSIX file locks (Linux/macOS). Install the
**package directory**, which contains both `plugin.yaml` and `__init__.py`:

```sh
profile_home="/absolute/path/to/profile/home"
mkdir -p "$profile_home/plugins"
ln -s /absolute/path/to/Score/hermes-plugin/score_bridge "$profile_home/plugins/score-bridge"
hermes -p builder plugins enable score-bridge
```

Replace `builder` with the profile name. To copy instead of symlinking, use
`cp -R /absolute/path/to/Score/hermes-plugin/score_bridge "$profile_home/plugins/score-bridge"`.
Repeat for each profile to observe. The gateway supports plugin hot reload; newly started
CLI, Kanban and cron processes load the enabled plugin.

Score's server (task 1.14) creates `~/.score/bridge.token`. Do not create a substitute token
or point the bridge at Hermes credential files. Without this bootstrap token, events spool
locally until Score is set up. `SCORE_URL` overrides the default `http://127.0.0.1:8740` and
must be set in the environment of the Hermes process. Hermes's context-local profile helper identifies each event; `HERMES_PROFILE` and then
`default` are fallbacks. `HERMES_KANBAN_TASK` identifies worker producers.

## Delivery and recovery

Each process has a random incarnation, a 10,000-event queue, and one daemon sender.
Each profile has its own producer token, incarnation suffix, counters and spool file.
Hooks capture plain-data snapshots (exact builtin types only), with 2,000-node and depth-8
budgets. Foreign objects become `<TypeName>`; strings over 16,384 characters are replaced
wholesale with omission markers. Queue admission waits at most 2 ms; contention and oldest
queue evictions are counted and reported as gaps. Hooks perform no disk or network access.
The sender flushes every 250 ms or when 100 events accumulate, in batches of at most 200.
It redacts in the captured context, masks credential fields, and bounds serialized payloads
to 64 KiB. Strings are redacted before truncation. Terminal command digests are captured
before redaction and mutation; only redacted command text leaves the process.

The sender writes batches before requesting delivery. This makes an in-flight batch durable
when a request stalls during shutdown. Producer tokens are renewed within 60 seconds of
expiry and after a 401. Only acknowledged events are removed; duplicate deliveries are safe
under the server's `(incarnation, counter)` ingest key.

`~/.score/spool/` is 0700 and its JSONL files are 0600. The bridge refuses to spool if
its parent or spool directory has foreign ownership or group/world write permissions.
Each JSONL envelope contains a batch and its producer's handshake identity, **without tokens**.
Physical caps are 5 MiB per file and 50 MiB for the directory. An inter-process lock protects
eviction and acknowledgement. Binary reads are bounded; corrupt records become durable
loss indications with `corrupt_records` counts. Internal loss flags live in the envelope,
separately from hook payloads; `_`-prefixed hook fields are omitted.

Queue gaps reserve the first slot in the next batch; pending range metadata is merged and
bounded to 100 entries per profile. Durable losses are materialized with fresh counters,
after existing immutable spool history and before new observations, so lost acknowledgements
cannot cause ingest-key collisions. Envelopes record when producer history itself was evicted.
Existing spools drain before new events for each producer. Healthy current producers receive
priority over orphan recovery. Each exited producer gets independent recovery and backoff;
permanent 401/403/404 rejections move its file to bounded `quarantine/` storage and are counted.
Live producer PIDs are left alone; PID reuse can defer recovery.

Forked children replace all sender state and close inherited spool descriptors. Existing
wrappers resolve the child sender, which starts lazily on the first hook. Hot reload replaces
the sender; unload stops it and unregisters its exact exit callback. Shutdown synchronously
redacts and spools queued snapshots within a two-second budget, without network access or
new threads; remaining work is counted as dropped. Disk failures stay fail-open and create
bounded in-memory loss metadata for a later attempt. Process termination before persistence
can still lose queued observations.

The private API boundary is `hermes_private.py`. Missing or failing Hermes redaction uses the
local secret-pattern fallback. Host processes report `host` even though Hermes's isolation
helper reports `in_process` inside the host. Unknown isolation still reports events; the
server disables actions in that mode. Cancellation signals propagate; diagnostics are a
bounded ring of error locations, never raw exception text.

## Offline validation

```sh
cd hermes-plugin
uv run --offline pytest -q
uv run --offline python -m compileall score_bridge
```

Tests substitute the private boundary and transport; they never import Hermes or contact a
live gateway. Installation instructions are kept here because task 1.13a restricts changes
to `hermes-plugin/`; a later documentation task can link them from `docs/SETUP.md`.
