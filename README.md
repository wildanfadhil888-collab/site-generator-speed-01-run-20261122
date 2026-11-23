# sitegen-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wildanfadhil888-collab/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wildanfadhil888-collab/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0 — a static site generator that answers exactly as makefun-site does on every case, but faster. Built for the [make.fun "Build a static site faster" bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` reimplements the whole build (front matter, Markdown subset, template dialect, slugs, collections, tags, pagination, build report) as a single-pass renderer: no lex token array, bulk plain-run copying with one regex escape per run, front-matter parsing merged into the line scan, and cached reading-time per source. On the practice set (3 cases, ~1,070 Markdown sources) it runs in ~0.74 s CPU vs ~1.37 s for the house baseline (~1.9x), with byte-identical output on the practice set and 12 freshly generated cases.

## The files

- `solve.js`: the entry. `run(input)` returns makefun-site's answer for one case's input.
- `main.ts`: the driver the harness runs — reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.
- `package.json`, `LICENSE`: MIT.

<sub>Entered on [make.fun](https://make.fun/?ref=x03vwtz9&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
