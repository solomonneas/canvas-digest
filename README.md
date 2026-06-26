# canvas-digest

Daily digest of your Canvas LMS: what changed, what's due, what was graded, new announcements and discussions.

`canvas-digest` reads your active Canvas courses, persists a daily snapshot, diffs it against yesterday's snapshot, and assembles a brief grouped into:

- **Action required** - assignments due in the next two days that you haven't submitted.
- **This week** - upcoming deadlines and unread announcements/discussions.
- **What changed** - new, graded, due-date-changed, or removed items since the last run.
- **Discovery** - lower-priority breadth (reserved for future sources).

It can optionally deliver the brief to Telegram and/or Discord. With no delivery credentials configured, it still writes a snapshot you can read directly.

## How it works

By default `canvas-digest` talks to the Canvas REST API using a personal access token. No extra services, no browser automation. For schools that disable API tokens, an optional browser-bridge fallback exists (see [Browser-bridge fallback](#browser-bridge-fallback)).

## Requirements

- Node.js >= 22 (uses native `fetch`)
- A Canvas account at a school running Canvas (the host usually looks like `https://your-school.instructure.com`)

## Create a Canvas API token

1. Log in to Canvas in your browser.
2. Go to **Account -> Settings**.
3. Under **Approved Integrations**, click **+ New Access Token**.
4. Give it a purpose (e.g. "canvas-digest") and, optionally, an expiry.
5. Click **Generate Token** and copy the token immediately (Canvas only shows it once).

If your school has disabled token generation, that section will be missing or greyed out. Use the [browser-bridge fallback](#browser-bridge-fallback) instead.

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

## Browser-bridge fallback

Some schools disable Canvas API tokens. For those cases, `canvas-digest` supports a fallback source that drives a logged-in Chrome profile through a separate "browser-bridge" binary.

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
