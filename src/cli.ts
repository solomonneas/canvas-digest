#!/usr/bin/env node
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasApiSource } from './sources/canvas-api.js';
import { CanvasSource } from './sources/canvas-source.js';
import { BrowserBridgeShellRunner } from './sources/browser-bridge.js';
import type {
  CanvasAssignmentEnvelope,
  CanvasCourseEnvelope,
  CanvasNotificationEnvelope,
  CanvasSnapshot,
} from './sources/canvas-source.js';
import { writeSnapshot } from './snapshot/writer.js';
import { parseSnapshot } from './snapshot/reader.js';
import { composeDigest } from './digest/compose.js';
import type { Digest } from './digest/compose.js';
import { formatTelegramDigest } from './digest/format.js';
import { formatDiscordDigest } from './digest/format-discord.js';
import { sendTelegram } from './deliver/telegram.js';
import { sendDiscordMessages } from './deliver/discord.js';
import type { CanvasDigestPayload } from './snapshot/format.js';

// Where daily snapshots are written. Externalized so the tool has no machine-
// specific assumptions. Precedence: CANVAS_DIGEST_SNAPSHOT_DIR, then
// $XDG_DATA_HOME/canvas-digest, then ./snapshots.
function snapshotDir(): string {
  if (process.env.CANVAS_DIGEST_SNAPSHOT_DIR) return process.env.CANVAS_DIGEST_SNAPSHOT_DIR;
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'canvas-digest');
  return join(process.cwd(), 'snapshots');
}

function today(): string {
  return new Date().toLocaleDateString('en-CA');
}

function yesterdayDate(): string {
  const d = new Date(Date.now() - 86400000);
  return d.toLocaleDateString('en-CA');
}

interface CliFlags {
  dryRun: boolean;
  noSnapshot: boolean;
  lookahead: number;
}

interface CanvasCliFlags {
  json: boolean;
  lookahead: number;
  limit?: number;
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    noSnapshot: false,
    lookahead: 14,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--no-snapshot') flags.noSnapshot = true;
    else if (a === '--lookahead') {
      const v = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(v) && v > 0) flags.lookahead = v;
    }
  }
  return flags;
}

function parsePositiveIntFlag(value: string | undefined): number | undefined {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCanvasFlags(args: string[]): CanvasCliFlags {
  const flags: CanvasCliFlags = { json: false, lookahead: 14 };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--lookahead') {
      const next = parsePositiveIntFlag(args[++i]);
      if (next !== undefined) flags.lookahead = next;
    } else if (a === '--limit') {
      flags.limit = parsePositiveIntFlag(args[++i]);
    }
  }
  return flags;
}

// Build the configured Canvas source. The default is the REST API; set
// CANVAS_SOURCE=browser-bridge to use the optional Chrome-profile fallback.
interface CanvasFetcher {
  fetch(opts: { lookahead_days?: number; since?: Date; limits?: { courses?: number; assignments?: number; notifications?: number } }): Promise<CanvasSnapshot>;
}

function resolveCanvasSource(): { source: CanvasFetcher } | { error: string } {
  const sourceKind = (process.env.CANVAS_SOURCE ?? 'api').trim();
  if (sourceKind === 'browser-bridge') {
    const binaryPath = process.env.BROWSER_BRIDGE_PATH;
    if (!binaryPath) {
      return {
        error:
          'CANVAS_SOURCE=browser-bridge requires BROWSER_BRIDGE_PATH (path to your browser-bridge binary)',
      };
    }
    const profileName = process.env.CANVAS_PROFILE_NAME;
    const runner = new BrowserBridgeShellRunner({ binaryPath });
    return { source: new CanvasSource(profileName ? { runner, profileName } : { runner }) };
  }
  // Default: Canvas REST API.
  const baseUrl = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_API_TOKEN;
  if (!baseUrl || !token) {
    return {
      error:
        'Canvas REST API source requires CANVAS_BASE_URL and CANVAS_API_TOKEN ' +
        '(or set CANVAS_SOURCE=browser-bridge for the fallback)',
    };
  }
  return { source: new CanvasApiSource({ baseUrl, token }) };
}

async function loadPriorSnapshot(path: string): Promise<CanvasDigestPayload | null> {
  try {
    await access(path);
  } catch {
    return null;
  }
  try {
    return parseSnapshot(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function truncateText(value: string, max = 92): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function printCanvasCourses(canvas: CanvasSnapshot): void {
  if (canvas.courses.length === 0) {
    console.log('No Canvas courses found.');
    return;
  }
  for (const course of canvas.courses) {
    const term = course.term ? ` (${course.term})` : '';
    const role = course.role ? ` [${course.role}]` : '';
    console.log(`${course.code || course.course_id}${term}${role} - ${course.name}`);
    if (course.url) console.log(`  ${course.url}`);
  }
}

function printCanvasAssignments(canvas: CanvasSnapshot): void {
  if (canvas.assignments.length === 0) {
    console.log('No upcoming Canvas assignments found.');
    return;
  }
  for (const assignment of canvas.assignments) {
    const due = assignment.due_at_local || assignment.due_at || 'no due date';
    const points =
      assignment.points_possible === null ? '' : ` - ${assignment.points_possible} pts`;
    console.log(
      `${due} - ${assignment.course_code} - ${assignment.title}${points} - ${assignment.submission_status}`,
    );
    if (assignment.url) console.log(`  ${assignment.url}`);
  }
}

function printCanvasNotifications(canvas: CanvasSnapshot): void {
  if (canvas.notifications.length === 0) {
    console.log('No recent Canvas notifications found.');
    return;
  }
  for (const notification of canvas.notifications) {
    const posted = notification.posted_at ?? 'unknown date';
    const labels =
      notification.labels.length > 0 ? ` [${notification.labels.join(', ')}]` : '';
    console.log(
      `${posted} - ${notification.course_code} - ${notification.kind} - ${notification.title}${labels}`,
    );
    if (notification.summary) console.log(`  ${truncateText(notification.summary)}`);
    if (notification.url) console.log(`  ${notification.url}`);
  }
}

function printCanvasItems(canvas: CanvasSnapshot): void {
  const items = [
    ...canvas.assignments.map((assignment) => ({
      sort: assignment.due_at ?? '',
      line:
        `${assignment.due_at_local || assignment.due_at || 'no due date'} - ` +
        `${assignment.course_code} - assignment - ${assignment.title} - ` +
        `${assignment.submission_status}`,
      url: assignment.url,
    })),
    ...canvas.notifications.map((notification) => ({
      sort: notification.posted_at ?? '',
      line:
        `${notification.posted_at ?? 'unknown date'} - ${notification.course_code} - ` +
        `${notification.kind} - ${notification.title}`,
      url: notification.url,
    })),
  ].sort((a, b) => a.sort.localeCompare(b.sort));

  if (items.length === 0) {
    console.log('No Canvas items found.');
    return;
  }
  for (const item of items) {
    console.log(item.line);
    if (item.url) console.log(`  ${item.url}`);
  }
}

// ad-hoc listing command: `canvas-digest canvas <section> [list] [--json] ...`.
// Uses the configured source (REST API by default) for a single fetch and
// prints the requested slice. Useful for quick checks without delivery.
export async function canvasCommand(
  args: string[],
  injectedSource?: CanvasFetcher,
): Promise<number> {
  const [section, maybeAction, ...rest] = args;
  const action = maybeAction === 'list' || maybeAction === undefined ? 'list' : maybeAction;
  const flagArgs = maybeAction === 'list' ? rest : args.slice(1);

  if (!section || action !== 'list') {
    console.error(
      'Usage: canvas-digest canvas <courses|assignments|notifications|items> list ' +
        '[--json] [--limit <n>] [--lookahead <days>]',
    );
    return 64;
  }

  const validSections = new Set(['courses', 'assignments', 'notifications', 'items']);
  if (!validSections.has(section)) {
    console.error(`canvas-digest canvas: unknown section ${section}`);
    return 64;
  }

  const flags = parseCanvasFlags(flagArgs);

  let source: CanvasFetcher;
  if (injectedSource) {
    source = injectedSource;
  } else {
    const resolved = resolveCanvasSource();
    if ('error' in resolved) {
      console.error(`canvas-digest canvas: ${resolved.error}`);
      return 1;
    }
    source = resolved.source;
  }

  const limits: { courses?: number; assignments?: number; notifications?: number } = {};
  if (flags.limit !== undefined) {
    limits.courses = flags.limit;
    limits.assignments = flags.limit;
    limits.notifications = flags.limit;
  }
  const snap = await source.fetch({ lookahead_days: flags.lookahead, limits });

  const sectionOk: Record<string, boolean> = {
    courses: snap.sources_ok.courses,
    assignments: snap.sources_ok.assignments,
    notifications: snap.sources_ok.notifications,
    items: snap.sources_ok.assignments && snap.sources_ok.notifications,
  };
  if (!sectionOk[section]) {
    const err = snap.errors;
    const detail =
      section === 'courses'
        ? err?.courses
        : section === 'notifications'
          ? err?.notifications
          : err?.assignments;
    const code = detail?.code ?? 'fetch_failed';
    const message = detail?.message ? `: ${detail.message}` : '';
    console.error(`canvas-digest canvas: ${section} failed ${code}${message}`);
    return 2;
  }

  if (section === 'courses') {
    if (flags.json) printJson(snap.courses);
    else printCanvasCourses(snap);
    return 0;
  }
  if (section === 'assignments') {
    if (flags.json) printJson(snap.assignments);
    else printCanvasAssignments(snap);
    return 0;
  }
  if (section === 'notifications') {
    if (flags.json) printJson(snap.notifications);
    else printCanvasNotifications(snap);
    return 0;
  }
  // items
  if (flags.json) printJson({ assignments: snap.assignments, notifications: snap.notifications });
  else printCanvasItems(snap);
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
  const startedAt = Date.now();
  const flags = parseFlags(args);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  const discordWebhook = process.env.DISCORD_WEBHOOK_URL;

  const resolved = resolveCanvasSource();
  if ('error' in resolved) {
    console.error(`canvas-digest run: ${resolved.error}`);
    return 1;
  }

  let canvas: CanvasSnapshot;
  try {
    canvas = await resolved.source.fetch({ lookahead_days: flags.lookahead });
  } catch (e) {
    console.error(`canvas-digest run: canvas source error ${(e as Error).message}`);
    return 1;
  }

  const payload: CanvasDigestPayload = { fetched_at: canvas.fetched_at, canvas };

  const todayStr = today();
  const base = snapshotDir();
  let snapshotRelPath = '';
  if (!flags.noSnapshot) {
    await mkdir(base, { recursive: true });
    const snapshotPath = join(base, `${todayStr}.md`);
    const md = writeSnapshot(payload, { date: todayStr, generatedAt: payload.fetched_at });
    await writeFile(snapshotPath, md, 'utf-8');
    snapshotRelPath = `${todayStr}.md`;
  }

  const priorPath = join(base, `${yesterdayDate()}.md`);
  const priorPayload = await loadPriorSnapshot(priorPath);

  const digest: Digest = composeDigest(payload, priorPayload, todayStr);

  type LaneStatus = 'sent' | 'error' | 'no-creds' | 'suppressed' | 'dry-run';

  // -------- Telegram --------
  let telegram: LaneStatus;
  if (flags.dryRun) {
    telegram = 'dry-run';
  } else if (digest.isEmpty) {
    telegram = 'suppressed';
  } else if (botToken && chatId) {
    try {
      const html = formatTelegramDigest(digest, snapshotRelPath);
      await sendTelegram({ botToken, chatId, html });
      telegram = 'sent';
    } catch (e) {
      console.error(`canvas-digest run: telegram error ${(e as Error).message}`);
      telegram = 'error';
    }
  } else {
    telegram = 'no-creds';
  }

  // -------- Discord --------
  let discord: LaneStatus;
  if (flags.dryRun) {
    discord = 'dry-run';
  } else if (digest.isEmpty) {
    discord = 'suppressed';
  } else if (discordWebhook) {
    try {
      const messages = formatDiscordDigest(digest);
      await sendDiscordMessages({ webhookUrl: discordWebhook, messages });
      discord = 'sent';
    } catch (e) {
      console.error(`canvas-digest run: discord error ${(e as Error).message}`);
      discord = 'error';
    }
  } else {
    discord = 'no-creds';
  }

  const durationMs = Date.now() - startedAt;
  const canvasPart = `canvas=${canvas.courses.length}/${canvas.assignments.length}/${canvas.notifications.length}`;
  const allOk =
    canvas.sources_ok.courses &&
    canvas.sources_ok.assignments &&
    canvas.sources_ok.notifications;

  console.log(
    [
      `canvas-digest run: ${allOk ? 'ok' : 'partial'}`,
      canvasPart,
      `changes=${digest.diff_events.length}`,
      `tg-${telegram}`,
      `dc-${discord}`,
      `duration=${(durationMs / 1000).toFixed(1)}s`,
    ].join(' '),
  );
  return allOk ? 0 : 2;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? '';
  const rest = process.argv.slice(3);
  switch (cmd) {
    case 'run': {
      const code = await runCommand(rest);
      process.exit(code);
      break;
    }
    case 'canvas': {
      const code = await canvasCommand(rest);
      process.exit(code);
      break;
    }
    default:
      console.error(
        'Usage:\n' +
          '  canvas-digest run [--dry-run] [--no-snapshot] [--lookahead <days>]\n' +
          '  canvas-digest canvas <courses|assignments|notifications|items> list [--json] [--limit <n>] [--lookahead <days>]\n' +
          '\n' +
          'Env:\n' +
          '  CANVAS_BASE_URL, CANVAS_API_TOKEN  (default REST API source)\n' +
          '  CANVAS_SOURCE=browser-bridge       (optional fallback; needs BROWSER_BRIDGE_PATH)\n' +
          '  CANVAS_DIGEST_SNAPSHOT_DIR         (where snapshots are written; default ./snapshots)\n' +
          '  TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, DISCORD_WEBHOOK_URL  (optional delivery)',
      );
      process.exit(64);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((e) => {
    console.error(`canvas-digest: ${(e as Error).message}`);
    process.exit(1);
  });
}
