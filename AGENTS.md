# Repository Guidance

## Definition of Done
```
./scripts/verify
```
Runs `npm test`, `npm run typecheck`, and `npm run build` in order, failing fast on the first error.

Before reporting any change complete, run it and confirm it passes:
- `npm test` (vitest suite under `tests/`, fixtures only, no live services)
- `npm run typecheck` (`tsc --noEmit`)
- `npm run build` (emits `dist/`; the installed `canvas-digest` bin runs from `dist/`)

Re-run them after your final edit, not from memory of an earlier run. Report the actual results. If anything fails, paste the failure verbatim and say the task is NOT done. Never claim success you did not observe.

## Project Shape
- Daily Canvas LMS digest CLI in TypeScript (ESM, Node >= 22, no runtime dependencies). Fetches active courses, assignments, announcements, and discussions; diffs against the previous snapshot; and delivers a single brief to Telegram and/or Discord.
- `src/cli.ts` is the only executable entry point, with two subcommands: `canvas-digest run [...]` and `canvas-digest canvas <section> list [...]`. `src/index.ts` is the library export surface.
- Pipeline: `src/sources/` (`canvas-api.ts` is the default REST source; `canvas-source.ts` + `browser-bridge.ts` are the optional fallback and the shared CanvasSnapshot data model), `src/snapshot/` (Markdown snapshot writer/reader), `src/digest/` (diff, compose, Telegram and Discord formatting), `src/deliver/` (Telegram, Discord).

## Rules
- Touching `src/sources/`: sources never throw on transport failure. They return a CanvasSnapshot with per-section `sources_ok` flags and an `errors` map, and `run` reports `partial` with exit code 2. Preserve that contract; do not add throws or retries that break it.
- Both sources must produce the same `CanvasSnapshot` shape (defined in `src/sources/canvas-source.ts`). The whole digest/diff/snapshot pipeline depends on that shape.
- Changing snapshot payload shape: `SNAPSHOT_VERSION` lives in `src/snapshot/format.ts`. The reader ignores the version line and parses the fenced JSON tail. New shapes must still parse the previous day's file or the diff misreports. Add a backward-compat test before changing the shape.
- Citing a command, flag, or env var: read the code first. The code is the source of truth.

## Live Boundary
- `canvas-digest run` is LIVE: it calls the Canvas API (or drives a real Chrome profile via browser-bridge), writes a snapshot to disk, and can send real Telegram DMs and Discord webhook posts. For any manual, test, or review run use `--dry-run --no-snapshot`.
- Delivery and auth come from env vars (`CANVAS_BASE_URL`, `CANVAS_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`, `DISCORD_WEBHOOK_URL`). Never hardcode tokens or webhook URLs.

## Prohibitions
- Never weaken, skip, or delete a failing test to get green. Fix the code or report the failure.
- Never invent commands or API behavior. Verify in `package.json` and `src/`.

## Gotchas
- The browser-bridge binary is a separate, user-supplied program with no default path; it is selected only via `CANVAS_SOURCE=browser-bridge` + `BROWSER_BRIDGE_PATH`. Token-based API access is the default.
- Browser-bridge Canvas calls run sequentially on purpose: a single Chrome profile lock allows one session at a time. Do not parallelize them.
- A green test suite proves nothing about a live Canvas account or browser profile; tests use injected fakes.
