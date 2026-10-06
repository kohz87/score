# Task log

One entry per completed task: what landed, review results, and any **rejected review finding with the reason**.

| Date | Task | Reviews | Notes / rejected findings |
|---|---|---|---|
| 2026-10-06 | Phase 0 | Codex plugin not loaded yet; reviews pending | — |
| 2026-10-06 | Architecture adversarial review | Codex CLI gpt-6.1-sol, max (245k tokens) | 20 findings (2 critical). All accepted; #3 partly (same-user threat model is an owner decision). Each claim verified against Hermes e97923c3. ARCHITECTURE → v0.2; contract, PLAN Phase 1, AGENTS.md and SPIKE corrected. Rejected: none. |
| 2026-10-06 | 1.1 Contract package | Codex CLI gpt-6.1-sol high, 2 rounds (~98k + fix tokens); Claude line review | 48 schemas, 318 tests; all checks green. Round 1 asked for: integer/non-negative counts, sha256 digest, lenient control frames that still reject `seq`, Watch surface refinement, TextEncoder, health test via CONTRACT_VERSION. Accepted Codex's unrequested `lib: DOM` in packages/contract tsconfig (only built-in way to type TextEncoder for code shared by browser and server). Contract decisions: ack → 204, `wait` 0–30 s. Rejected findings: none. Tooling: fixed two codex-task.sh bugs (pipefail round count, ANSI in session id). |
| 2026-10-06 | 1.2 Server skeleton + session pairing | Codex CLI gpt-6.1-sol high, 2 rounds (~89k + fix); Claude line review + live curl smoke test | 76 server tests; all checks green. Round 1 asked for: startup error reasons, loopback origin aliases (localhost vs 127.0.0.1), redacted 500 logs with stacks. Smoke test: header/origin rejections 403, pairing 204 with correct cookie flags, token reuse 401, no cookie in logs. Sessions are in-memory until 1.3. Rejected findings: none. |
