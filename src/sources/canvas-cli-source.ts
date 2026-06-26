// src/sources/canvas-cli-source.ts
//
// Token-free Canvas data source backed by the `canvas-cli` companion binary.
//
// Some schools (e.g. universities that disable Canvas personal access tokens)
// cannot use the default REST API source. `canvas-cli` solves exactly that: it
// logs in through the school's normal browser SSO (Playwright) and keeps a
// persistent session, so no API token is needed. This source shells out to that
// binary, asks for JSON, and maps the result into the SAME CanvasSnapshot the
// rest of the pipeline (snapshot/diff/compose) consumes. It is therefore a
// drop-in alternative to canvas-api.ts and canvas-source.ts.
//
// canvas-cli emits these JSON shapes (see its src/types.ts):
//   courses list --json        -> CanvasCourse[]      (== CanvasCourseEnvelope)
//   items list --json          -> { assignments: CanvasAssignment[],
//                                    notifications: CanvasNotification[] }
//   assignments list --json    -> CanvasAssignment[]  (== CanvasAssignmentEnvelope)
//   notifications list --json   -> CanvasNotification[] (== CanvasNotificationEnvelope)
//
// The field names are identical to our *Envelope types, so the mapping is a
// validated pass-through (we coerce/normalize rather than re-key). We use the
// combined `items` command so the assignments + notifications pair comes from a
// single invocation, plus one `courses` invocation: two spawns total.
//
// Like the other sources, this never throws on a per-section failure: it records
// ok/error per section and returns a partial CanvasSnapshot. The one exception
// surfaced to the caller as a thrown error is a hard "canvas-cli is unusable"
// condition (binary not installed, or not logged in), where every section would
// fail identically and a clear, actionable message is more useful than a
// degraded-but-silent snapshot.

import { execFile } from 'node:child_process';

import type {
  CanvasSnapshot,
  CanvasCourseEnvelope,
  CanvasAssignmentEnvelope,
  CanvasNotificationEnvelope,
  CanvasByCourseEnvelope,
  CanvasSourcesOk,
  CanvasSourceErrors,
  CanvasFetchOptions,
} from './canvas-source.js';

export const DEFAULT_CANVAS_CLI_BIN = 'canvas-cli';

export const DEFAULT_CANVAS_CLI_TIMEOUT_MS = 120_000;

// Max stdout buffered from canvas-cli. Generous: a busy term's items + courses
// JSON is small (tens of KB), but headroom avoids truncating large accounts.
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Result of running one canvas-cli subcommand.
 *   - ok: process exited 0.
 *   - stdout/stderr: captured output.
 *   - code: exit code (null if killed by signal).
 *   - errno: 'ENOENT' when the binary itself could not be spawned.
 */
export interface CanvasCliRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  errno?: string;
}

/**
 * Runs a canvas-cli subcommand. Injected in tests so the mapping can be
 * exercised without spawning a real binary.
 */
export interface CanvasCliRunner {
  run(args: string[]): Promise<CanvasCliRunResult>;
}

export interface CanvasCliSourceOptions {
  /** Path or command name for the canvas-cli binary. Default: "canvas-cli". */
  bin?: string;
  /** Canvas base URL; passed as --base-url when set. */
  baseUrl?: string;
  /** canvas-cli profile name; passed as --profile when set. */
  profileName?: string;
  /** Per-invocation timeout in ms. Default 120s (SSO scraping is slow). */
  timeoutMs?: number;
  /** Test seam: supply a fake runner instead of spawning a process. */
  runner?: CanvasCliRunner;
  /** Optional logger for non-fatal warnings. */
  logger?: (msg: string) => void;
}

/** Error thrown when canvas-cli cannot be used at all (not installed / not logged in). */
export class CanvasCliUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CanvasCliUnavailableError';
    this.code = code;
  }
}

const INSTALL_HINT =
  'install canvas-cli and run `canvas-cli login`, or use CANVAS_SOURCE=api with a token';

// canvas-cli prints auth failures to stderr with an `auth_required` /
// `auth_expired` code and a "not logged in. Run `canvas-cli login`" line.
function looksLikeAuthError(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('auth_required') ||
    t.includes('auth_expired') ||
    t.includes('not logged in') ||
    t.includes('canvas-cli login')
  );
}

/** Default runner: spawn the real binary via execFile, capturing stdout/stderr. */
class ExecFileCanvasCliRunner implements CanvasCliRunner {
  constructor(
    private readonly bin: string,
    private readonly timeoutMs: number,
  ) {}

  run(args: string[]): Promise<CanvasCliRunResult> {
    return new Promise((resolve) => {
      execFile(
        this.bin,
        args,
        { timeout: this.timeoutMs, maxBuffer: MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ ok: true, stdout, stderr, code: 0 });
            return;
          }
          const err = error as NodeJS.ErrnoException & { code?: number | string };
          // execFile overloads `code`: it is the spawn errno (e.g. "ENOENT")
          // when the process never started, otherwise the numeric exit code.
          const errno = typeof err.code === 'string' ? err.code : undefined;
          const exitCode = typeof err.code === 'number' ? err.code : null;
          resolve({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: exitCode,
            errno,
          });
        },
      );
    });
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asLabels(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string');
}

function mapCourse(raw: unknown): CanvasCourseEnvelope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const env: CanvasCourseEnvelope = {
    course_id: asString(r.course_id),
    code: asString(r.code),
    name: asString(r.name),
    term: asStringOrNull(r.term),
    url: asString(r.url),
  };
  if (typeof r.role === 'string') env.role = r.role;
  return env;
}

function mapAssignment(raw: unknown): CanvasAssignmentEnvelope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const env: CanvasAssignmentEnvelope = {
    assignment_id: asString(r.assignment_id),
    course_id: asString(r.course_id),
    course_code: asString(r.course_code),
    kind: asString(r.kind),
    title: asString(r.title),
    due_at: asStringOrNull(r.due_at),
    due_at_local: asString(r.due_at_local),
    points_possible: asNumberOrNull(r.points_possible),
    submission_status: asString(r.submission_status),
    url: asString(r.url),
  };
  if (typeof r.course_name === 'string') env.course_name = r.course_name;
  if (Array.isArray(r.labels)) env.labels = asLabels(r.labels);
  return env;
}

function mapNotification(raw: unknown): CanvasNotificationEnvelope {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    notification_id: asString(r.notification_id),
    course_id: asString(r.course_id),
    course_code: asString(r.course_code),
    course_name: asString(r.course_name),
    kind: asString(r.kind),
    title: asString(r.title),
    summary: asString(r.summary),
    url: asString(r.url),
    posted_at: asStringOrNull(r.posted_at),
    labels: asLabels(r.labels),
  };
}

// Derive the by_course rollup the API source also produces, so downstream
// formatting/diffing sees a consistent snapshot regardless of source.
function buildByCourse(
  assignments: CanvasAssignmentEnvelope[],
  courses: CanvasCourseEnvelope[],
): CanvasByCourseEnvelope[] {
  const nameById = new Map<string, { code: string; name: string }>();
  for (const c of courses) nameById.set(c.course_id, { code: c.code, name: c.name });

  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const a of assignments) {
    if (!counts.has(a.course_id)) order.push(a.course_id);
    counts.set(a.course_id, (counts.get(a.course_id) ?? 0) + 1);
  }

  return order.map((course_id) => {
    const meta = nameById.get(course_id);
    // Fall back to the first assignment's course_code if the course list did
    // not include this id (canvas-cli courses + items are independent calls).
    const fromAssignment = assignments.find((a) => a.course_id === course_id);
    return {
      course_id,
      course_code: meta?.code ?? fromAssignment?.course_code ?? '',
      course_name: meta?.name ?? fromAssignment?.course_name ?? '',
      count: counts.get(course_id) ?? 0,
    };
  });
}

export class CanvasCliSource {
  private readonly bin: string;
  private readonly baseUrl?: string;
  private readonly profileName?: string;
  private readonly runner: CanvasCliRunner;
  private readonly logger?: (msg: string) => void;

  constructor(opts: CanvasCliSourceOptions = {}) {
    this.bin = opts.bin && opts.bin.trim() ? opts.bin.trim() : DEFAULT_CANVAS_CLI_BIN;
    this.baseUrl = opts.baseUrl?.trim() ? opts.baseUrl.trim().replace(/\/+$/, '') : undefined;
    this.profileName = opts.profileName?.trim() ? opts.profileName.trim() : undefined;
    this.logger = opts.logger;
    this.runner =
      opts.runner ??
      new ExecFileCanvasCliRunner(this.bin, opts.timeoutMs ?? DEFAULT_CANVAS_CLI_TIMEOUT_MS);
  }

  // Build the shared flag tail every subcommand gets: --json plus the optional
  // --base-url / --profile pulled from config.
  private commonArgs(): string[] {
    const args = ['--json'];
    if (this.baseUrl) args.push('--base-url', this.baseUrl);
    if (this.profileName) args.push('--profile', this.profileName);
    return args;
  }

  // Run one subcommand and parse its JSON. Throws CanvasCliUnavailableError on a
  // hard failure (not installed / not logged in); returns null on a soft,
  // section-local failure (the caller records a per-section error instead).
  private async runJson(
    section: 'courses' | 'items',
    args: string[],
  ): Promise<unknown | null> {
    let result: CanvasCliRunResult;
    try {
      result = await this.runner.run(args);
    } catch (e) {
      // A runner that rejects (rare) is treated as a soft failure.
      this.logger?.(`canvas-cli: ${section} runner threw: ${(e as Error).message}`);
      return null;
    }

    if (!result.ok) {
      const combined = `${result.stderr}\n${result.stdout}`;
      if (result.errno === 'ENOENT') {
        throw new CanvasCliUnavailableError(
          'not_installed',
          `canvas-cli binary not found ("${this.bin}"). ${INSTALL_HINT}`,
        );
      }
      if (looksLikeAuthError(combined)) {
        throw new CanvasCliUnavailableError(
          'auth_required',
          `canvas-cli is not logged in. ${INSTALL_HINT}`,
        );
      }
      const detail = (result.stderr || result.stdout || `exit ${result.code ?? 'null'}`).trim();
      this.logger?.(`canvas-cli: ${section} failed: ${detail.slice(0, 300)}`);
      return null;
    }

    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (e) {
      this.logger?.(
        `canvas-cli: ${section} returned non-JSON: ${(e as Error).message}`,
      );
      return null;
    }
  }

  async fetch(opts: CanvasFetchOptions = {}): Promise<CanvasSnapshot> {
    const fetched_at = new Date().toISOString();
    const errors: CanvasSourceErrors = {};
    const sources_ok: CanvasSourcesOk = {
      courses: false,
      assignments: false,
      notifications: false,
    };

    // -------- courses --------
    let courses: CanvasCourseEnvelope[] = [];
    const coursesArgs = ['courses', 'list', ...this.commonArgs()];
    const coursesJson = await this.runJson('courses', coursesArgs);
    if (coursesJson !== null) {
      courses = asArray(coursesJson).map(mapCourse);
      sources_ok.courses = true;
    } else {
      errors.courses = { code: 'fetch_failed', message: 'canvas-cli courses list failed' };
    }
    if (opts.limits?.courses !== undefined) {
      courses.splice(opts.limits.courses);
    }

    // -------- items (assignments + notifications in one call) --------
    let assignments: CanvasAssignmentEnvelope[] = [];
    let notifications: CanvasNotificationEnvelope[] = [];
    const itemsArgs = ['items', 'list', ...this.commonArgs()];
    if (opts.lookahead_days !== undefined) {
      itemsArgs.push('--lookahead', String(opts.lookahead_days));
    }
    const itemsJson = await this.runJson('items', itemsArgs);
    if (itemsJson !== null && itemsJson && typeof itemsJson === 'object') {
      const view = itemsJson as Record<string, unknown>;
      assignments = asArray(view.assignments).map(mapAssignment);
      notifications = asArray(view.notifications).map(mapNotification);
      sources_ok.assignments = true;
      sources_ok.notifications = true;
    } else {
      const msg = 'canvas-cli items list failed';
      errors.assignments = { code: 'fetch_failed', message: msg };
      errors.notifications = { code: 'fetch_failed', message: msg };
    }

    // Apply the digest's `since` filter to notifications (canvas-cli has no
    // server-side since; filter locally on posted_at to match canvas-api).
    if (opts.since) {
      const sinceMs = opts.since.getTime();
      notifications = notifications.filter((n) => {
        if (!n.posted_at) return true;
        const t = new Date(n.posted_at).getTime();
        return !Number.isFinite(t) || t >= sinceMs;
      });
    }

    if (opts.limits?.assignments !== undefined) {
      assignments.splice(opts.limits.assignments);
    }
    if (opts.limits?.notifications !== undefined) {
      notifications.splice(opts.limits.notifications);
    }

    const by_course = buildByCourse(assignments, courses);

    const snapshot: CanvasSnapshot = {
      fetched_at,
      courses,
      assignments,
      notifications,
      by_course,
      sources_ok,
    };
    if (errors.courses || errors.assignments || errors.notifications) {
      snapshot.errors = errors;
    }
    return snapshot;
  }
}
