# Visual QA audit (lead, 2026-10-08)

Owner: "some of the button and arrow alignment are off, it needs to be checked again." Demo mode on `main` after 3.10,
every destination at 1440, 1024 and 390 px wide, compared with `docs/design/*.png` / `docs/design/html/*.html`.

| # | Where | Width | Problem | Task |
|---|---|---|---|---|
| 1 | App header (all pages) | 1024 | The avatar button wraps onto its own line under the logo | 3.14 |
| 2 | Tasks "All rooms" filter | all | Native select arrow, tight to the edge, unlike the pill buttons around it | 3.14 |
| 3 | Chat room header | 390 | "#activity-feed" breaks mid-word ("#activity-/feed"); "See it on the Score" floats beside it | 3.14 |
| 4 | Team agent tabs | 390 | Tabs wrap into three rows; should be one horizontally scrollable row | 3.14 |
| 5 | Reports By agent table | 390 | Right-hand columns are clipped instead of scrolling | 3.14 |
| 6 | Reports chart | 390 | Day labels and totals shrink with the SVG until unreadable | 3.14 |
| 7 | Settings rules columns | 1024 | "Never" sits alone in a second row; keep three columns down to ~900 px, then stack all three | 3.14 |
| 8 | Tasks card age | all | A just-started task reads "0 sec"; say "just now" | 3.14 |
| 9 | Chat "Files in play" | demo | Empty in the demo (scripted runs record no file edits); give the fake scenario edit tools with paths | 3.14 |
| 10 | Now timeline | 1024 | A generic "Working" block overlaps the task block for the same work in one lane (lanes builder emits both) | after 3.7 |
| 11 | Flow brief picker | all | Native select arrow (same as #2) | after 3.7 (reuse 3.14's select style) |
| 12 | Now/Flow title while loading | 1440 | Looked like a fallback font while the machine was under heavy load; re-check when idle | re-check |
