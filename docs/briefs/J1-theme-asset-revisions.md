# J1 — revision-bound theme assets (fourth gate P2, decision 104) → 1.8.1

Source: `docs/reviews/2026-10-18-phase9-regate4-codex-max.md`, finding 2.

Problem: asset (and licence) URLs name only the theme and path. After a **successful** replace of theme B over A, an
editor still holding A's manifest/CSS/etag reads B's bytes at the same path, and "Save as new" (or a save with files)
can store A's manifest/CSS with B's assets — a hybrid package nobody made.

Done when:
1. Asset URLs a client gets (`ThemeDetail`, the served `style.css` rewrite, the engine's `assetUrl`) carry the package
   revision (`?rev=<etag>` or a path segment); the server **enforces** it: a request naming an older revision is
   `409 etag_mismatch` (or 410), never the newer bytes. A request without a revision keeps working for the current one
   only if the contract says so — pick the stricter option if nothing depends on unversioned URLs.
2. The Customizer builds a copy ("Save as new", Start from, export of a draft) from one coherent snapshot: every asset
   and licence fetched with the same revision as the manifest/CSS it pairs with; a mismatch stops the copy with a plain
   message ("This theme changed while you were copying it. Reload and try again.").
3. Licence reads follow the same rule.
4. Contract § 16 updated first; tests fail first: the reviewer's route reproduction (read A, PUT B, A's asset URL →
   refused; hybrid Save as new → refused), plus an e2e of the copy path.
Constraints: follow AGENTS.md; no new dependencies; no migration unless needed (then 0078); don't commit with `-A`.
