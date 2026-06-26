# canvas-digest

Daily digest of your Canvas LMS: what changed, what's due, what was graded, new announcements and discussions.

`canvas-digest` reads your active Canvas courses, persists a daily snapshot, diffs it against yesterday's snapshot, and assembles a brief grouped into:

- **Action required** - assignments due in the next two days that you haven't submitted.
- **This week** - upcoming deadlines and unread announcements/discussions.
- **What changed** - new, graded, due-date-changed, or removed items since the last run.
- **Discovery** - lower-priority breadth (reserved for future sources).

It can optionally deliver the brief to Telegram and/or Discord. With no delivery credentials configured, it still writes a snapshot you can read directly.

## How it works

`canvas-digest` can read your Canvas data three ways, selected with `CANVAS_SOURCE`:

| `CANVAS_SOURCE` | What it uses | When to use |
|---|---|---|
| `api` (default) | Canvas REST API + a personal access token | The simplest path when your school allows API tokens. |
| `canvas-cli` (alias `browser`) | The [`canvas-cli`](https://www.npmjs.com/package/canvas-cli) companion, which logs in through your school's normal browser SSO (no token) | **Recommended for schools that disable Canvas tokens** (e.g. some universities). |
| `browser-bridge` | Your own browser-bridge binary | Advanced fallback (see [Browser-bridge fallback](#browser-bridge-fallback)). |

All three produce the identical internal snapshot, so the digest, diff, and delivery behave the same regardless of source.

## Requirements

- Node.js >= 22 (uses native `fetch`)
- A Canvas account at a school running Canvas (the host usually looks like `https://your-school.instructure.com`)

## Create a Canvas API token

1. Log in to Canvas in your browser.
2. Go to **Account -> Settings**.
3. Under **Approved Integrations**, click **+ New Access Token**.
4. Give it a purpose (e.g. "canvas-digest") and, optionally, an expiry.
5. Click **Generate Token** and copy the token immediately (Canvas only shows it once).

If your school has disabled token generation, that section will be missing or greyed out. Use the [token-free source via canvas-cli](#token-free-source-via-canvas-cli) instead.

## Install

```bash
git clone <your-fork-or-clone-url> canvas-digest
cd canvas-digest
npm install
npm run build
# optional: make the canvas-digest command available globally
npm install -g .
```

## Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

```
# Source: api (default), canvas-cli (token-free, alias "browser"), or browser-bridge
CANVAS_SOURCE=api
CANVAS_BASE_URL=https://your-school.instructure.com
CANVAS_API_TOKEN=your-canvas-api-token
# optional delivery
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
DISCORD_WEBHOOK_URL=
# optional: where daily snapshots are written
CANVAS_DIGEST_SNAPSHOT_DIR=./snapshots
```

`canvas-digest` reads from the process environment. Load `.env` however you like, for example:

```bash
export $(grep -v '^#' .env | grep -v '^$' | xargs)
```

## Usage

Run the digest:

```bash
canvas-digest run
```

What happens on a run:

1. Fetch active courses, their assignments (with submission state), announcements, and discussion topics.
2. Write a dated snapshot (`<date>.md`) to the snapshot directory, unless `--no-snapshot`.
3. Diff against yesterday's snapshot to compute what changed.
4. Compose the brief and deliver it to Telegram/Discord if credentials are set.

The command prints a one-line status summary, for example:

```
canvas-digest run: ok canvas=4/37/9 changes=3 tg-sent dc-no-creds duration=2.1s
```

(`canvas=courses/assignments/notifications`.)

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Fetch and compose, but do not deliver. |
| `--no-snapshot` | Do not write the snapshot file. |
| `--lookahead <days>` | Assignment lookahead window (default 14). |

A safe manual check that touches nothing on disk and sends nothing:

```bash
canvas-digest run --dry-run --no-snapshot
```

### Ad-hoc listing

Inspect individual slices without writing snapshots or delivering:

```bash
canvas-digest canvas courses list
canvas-digest canvas assignments list --lookahead 21
canvas-digest canvas notifications list --json
canvas-digest canvas items list --limit 20
```

## Delivery (optional)

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token into `TELEGRAM_BOT_TOKEN`.
2. Find your numeric Telegram user id (e.g. via [@userinfobot](https://t.me/userinfobot)) and set `TELEGRAM_USER_ID`.
3. Send your bot any message once so it is allowed to DM you.

### Discord

Create a webhook in **Server Settings -> Integrations -> Webhooks**, copy the URL, and set `DISCORD_WEBHOOK_URL`.

When a digest is empty (no items and no changes), delivery is suppressed so you do not get a daily "nothing happened" ping.

## Snapshots

Each run writes a Markdown file named `<YYYY-MM-DD>.md` containing a human-readable summary plus a fenced JSON tail used for the next day's diff. The location is, in order of precedence:

1. `CANVAS_DIGEST_SNAPSHOT_DIR`
2. `$XDG_DATA_HOME/canvas-digest`
3. `./snapshots`

## Scheduling

`canvas-digest` is a one-shot command; schedule it however you prefer (cron, a systemd user timer, a CI cron, etc.). For a daily 7am run with cron:

```
0 7 * * *  cd /path/to/canvas-digest && export $(grep -v '^#' .env | grep -v '^$' | xargs) && node dist/cli.js run
```

## Token-free source via canvas-cli

Some schools (for example many universities) disable Canvas personal access tokens, so the default `api` source cannot authenticate. For those accounts, point `canvas-digest` at the [`canvas-cli`](https://www.npmjs.com/package/canvas-cli) companion. `canvas-cli` logs in once through your school's normal browser SSO (via Playwright) and keeps a persistent session, so no token is ever needed. `canvas-digest` shells out to it, asks for JSON, and maps the result into the same snapshot the API source produces.

### Quickstart

```bash
# 1. Install the companion CLI and a browser for it.
npm i -g canvas-cli
npx playwright install chromium

# 2. Log in once. A real Chromium window opens; complete your school's SSO.
CANVAS_BASE_URL=https://your-school.instructure.com canvas-cli login

# 3. Run canvas-digest against the token-free source.
CANVAS_SOURCE=canvas-cli CANVAS_BASE_URL=https://your-school.instructure.com canvas-digest run
```

After the one-time `canvas-cli login`, scheduled runs are non-interactive as long as the session stays valid. If a run reports that canvas-cli is not logged in, run `canvas-cli login` again to refresh the session.

### Configuration

```
CANVAS_SOURCE=canvas-cli                            # or "browser" (alias)
CANVAS_BASE_URL=https://your-school.instructure.com # passed to canvas-cli as --base-url
CANVAS_CLI_BIN=canvas-cli                           # optional: path/name of the binary (default "canvas-cli")
CANVAS_PROFILE_NAME=default                         # optional: named canvas-cli login profile
```

If `canvas-cli` is not installed or you are not logged in, `canvas-digest` fails fast with a clear message ("install canvas-cli and run `canvas-cli login`, or use CANVAS_SOURCE=api with a token") instead of producing an empty digest.

## Browser-bridge fallback

This is an **advanced** path. Most token-blocked schools should use the [token-free canvas-cli source](#token-free-source-via-canvas-cli) above. The browser-bridge source drives a logged-in Chrome profile through a separate "browser-bridge" binary that you supply.

The browser-bridge binary is **not** included with this project and is **off by default**. To use it:

```
CANVAS_SOURCE=browser-bridge
BROWSER_BRIDGE_PATH=/path/to/your/browser-bridge   # required, no default
CANVAS_PROFILE_NAME=canvas-digest                  # optional Chrome profile name
```

You must supply your own browser-bridge implementation that accepts `canvas <action>` invocations (`list-courses`, `list-upcoming-assignments`, `list-recent-notifications`) on argv, reads a JSON body on stdin, and writes a `{ ok, result, error }` JSON envelope on stdout. Token-based API access is the recommended default; the browser-bridge path exists only for token-blocked schools.

## Development

```bash
npm test         # vitest suite (fixtures only, no live services)
npm run typecheck
npm run build
./scripts/verify # runs all three in order
```

The test suite uses injected fakes (fetch spies, fake runners), so it never touches Canvas, Telegram, or Discord.

## License

MIT. See [LICENSE](LICENSE).
