// src/sources/canvas-api.ts
//
// Default Canvas data source: the Canvas REST API. Uses CANVAS_BASE_URL +
// CANVAS_API_TOKEN (Bearer header) and native fetch (Node 22). Produces the
// same CanvasSnapshot the rest of the pipeline (snapshot/diff/compose) already
// consumes, so it is a drop-in replacement for the browser-bridge source.
//
// Endpoints used:
//   - active courses:  GET /api/v1/courses?enrollment_state=active&per_page=100
//   - assignments:     GET /api/v1/courses/:id/assignments?include[]=submission&per_page=100
//   - announcements:   GET /api/v1/announcements?context_codes[]=course_<id>...
//   - discussions:     GET /api/v1/courses/:id/discussion_topics?per_page=100
//   - recent grades:   derived from assignment submissions where workflow_state
//                      is "graded" (no extra call; include[]=submission gives us
//                      the submission inline).
//
// Pagination follows the RFC 5988 Link header (rel="next").
//
// This source never throws on a per-endpoint failure: like the browser-bridge
// source it records ok/error per section and returns a partial CanvasSnapshot.

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

export interface CanvasApiSourceOptions {
  baseUrl: string;
  token: string;
  // Test seam: override the fetch implementation.
  fetchImpl?: typeof globalThis.fetch;
  // Per-request timeout in ms. Defaults to 30s.
  timeoutMs?: number;
  // Optional logger for non-fatal warnings.
  logger?: (msg: string) => void;
}

// ---------- raw Canvas REST shapes (only the fields we read) ----------

interface RawCourse {
  id: number;
  name?: string;
  course_code?: string;
  term?: { name?: string } | null;
  enrollment_term_id?: number;
  enrollments?: Array<{ type?: string; role?: string }>;
}

interface RawSubmission {
  workflow_state?: string; // 'submitted' | 'graded' | 'unsubmitted' | 'pending_review'
  submitted_at?: string | null;
  graded_at?: string | null;
  score?: number | null;
  grade?: string | null;
  late?: boolean;
  missing?: boolean;
}

interface RawAssignment {
  id: number;
  name?: string;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  submission_types?: string[];
  submission?: RawSubmission | null;
}

interface RawDiscussionTopic {
  id: number;
  title?: string;
  message?: string;
  html_url?: string;
  url?: string;
  posted_at?: string | null;
  last_reply_at?: string | null;
  created_at?: string | null;
  read_state?: string; // 'read' | 'unread'
  unread_count?: number;
  announcement?: boolean;
}

// ---------- helpers ----------

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Link: <url>; rel="next", <url>; rel="last"
  for (const part of linkHeader.split(',')) {
    const segments = part.split(';').map((s) => s.trim());
    const urlSeg = segments[0];
    const isNext = segments.some((s) => s === 'rel="next"' || s === "rel='next'");
    if (isNext && urlSeg?.startsWith('<') && urlSeg.endsWith('>')) {
      return urlSeg.slice(1, -1);
    }
  }
  return null;
}

function localDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  // Locale-stable, timezone-aware display. The digest renders due_at_local as
  // a human label; the ISO due_at remains the source of truth for diffing.
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function submissionStatus(sub: RawSubmission | null | undefined): string {
  if (!sub) return 'not_submitted';
  if (sub.workflow_state === 'graded') return 'graded';
  if (sub.missing) return 'missing';
  if (sub.late) return 'late';
  if (sub.workflow_state === 'submitted' || sub.submitted_at) return 'submitted';
  return 'not_submitted';
}

function stripHtml(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export class CanvasApiSource {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly logger?: (msg: string) => void;

  constructor(opts: CanvasApiSourceOptions) {
    // Normalize: strip any trailing slash so path joins are predictable.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger;
  }

  // Fetch one page and return parsed JSON plus the next-page URL.
  private async getPage<T>(url: string): Promise<{ items: T[]; next: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Canvas API ${res.status} for ${url}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as T[];
      const next = parseNextLink(res.headers.get('link'));
      return { items: Array.isArray(data) ? data : [], next };
    } finally {
      clearTimeout(timer);
    }
  }

  // Follow Link rel="next" until exhausted (or a sane page cap is hit).
  private async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    let guard = 0;
    while (url && guard < 50) {
      guard += 1;
      const page: { items: T[]; next: string | null } = await this.getPage<T>(url);
      out.push(...page.items);
      url = page.next;
    }
    return out;
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
    let rawCourses: RawCourse[] = [];
    try {
      rawCourses = await this.getAll<RawCourse>(
        '/api/v1/courses?enrollment_state=active&per_page=100',
      );
      sources_ok.courses = true;
    } catch (e) {
      errors.courses = { code: 'fetch_failed', message: (e as Error).message };
    }

    const courses: CanvasCourseEnvelope[] = rawCourses.map((c) => {
      const enrollment = c.enrollments?.[0];
      return {
        course_id: String(c.id),
        code: c.course_code ?? '',
        name: c.name ?? '',
        term: c.term?.name ?? null,
        role: enrollment?.role ?? enrollment?.type,
        url: `${this.baseUrl}/courses/${c.id}`,
      };
    });
    const courseNameById = new Map<string, { code: string; name: string }>();
    for (const c of courses) {
      courseNameById.set(c.course_id, { code: c.code, name: c.name });
    }

    if (opts.limits?.courses !== undefined) {
      courses.splice(opts.limits.courses);
    }

    // -------- assignments (per course, with submission) --------
    const assignments: CanvasAssignmentEnvelope[] = [];
    const byCourseCounts = new Map<string, number>();
    let assignmentsOk = true;
    if (sources_ok.courses) {
      for (const course of courses) {
        try {
          const raw = await this.getAll<RawAssignment>(
            `/api/v1/courses/${course.course_id}/assignments?include[]=submission&per_page=100`,
          );
          for (const a of raw) {
            const meta = courseNameById.get(course.course_id);
            assignments.push({
              assignment_id: String(a.id),
              course_id: course.course_id,
              course_code: meta?.code ?? course.code,
              course_name: meta?.name ?? course.name,
              kind: a.submission_types?.[0] ?? 'assignment',
              title: a.name ?? '(untitled assignment)',
              due_at: a.due_at ?? null,
              due_at_local: localDate(a.due_at),
              points_possible: a.points_possible ?? null,
              submission_status: submissionStatus(a.submission),
              url: a.html_url ?? `${this.baseUrl}/courses/${course.course_id}/assignments/${a.id}`,
            });
            byCourseCounts.set(
              course.course_id,
              (byCourseCounts.get(course.course_id) ?? 0) + 1,
            );
          }
        } catch (e) {
          assignmentsOk = false;
          this.logger?.(
            `canvas-api: assignments failed for course ${course.course_id}: ${(e as Error).message}`,
          );
          if (!errors.assignments) {
            errors.assignments = { code: 'fetch_failed', message: (e as Error).message };
          }
        }
      }
      sources_ok.assignments = assignmentsOk;
    } else {
      errors.assignments = { code: 'skipped', message: 'courses fetch failed' };
    }
    if (opts.limits?.assignments !== undefined) {
      assignments.splice(opts.limits.assignments);
    }

    const by_course: CanvasByCourseEnvelope[] = [];
    for (const [course_id, count] of byCourseCounts) {
      const meta = courseNameById.get(course_id);
      by_course.push({
        course_id,
        course_code: meta?.code ?? '',
        course_name: meta?.name ?? '',
        count,
      });
    }

    // -------- notifications: announcements + discussion activity --------
    // Announcements come from the global /announcements endpoint scoped to all
    // active courses. Discussion topics come per-course; unread topics are
    // surfaced so the digest can flag new threads/replies.
    const notifications: CanvasNotificationEnvelope[] = [];
    let notificationsOk = sources_ok.courses;
    const sinceMs = opts.since ? opts.since.getTime() : 0;

    if (sources_ok.courses && courses.length > 0) {
      // Announcements (batched context_codes on one query string).
      try {
        const contextCodes = courses
          .map((c) => `context_codes[]=course_${c.course_id}`)
          .join('&');
        const raw = await this.getAll<RawDiscussionTopic>(
          `/api/v1/announcements?${contextCodes}&per_page=100`,
        );
        for (const t of raw) {
          // The announcements endpoint does not echo the course id per item in
          // a stable field; the html_url carries it. Parse it out for context.
          const courseId = this.courseIdFromUrl(t.html_url ?? t.url ?? '');
          const meta = courseId ? courseNameById.get(courseId) : undefined;
          const posted = t.posted_at ?? t.created_at ?? null;
          if (sinceMs && posted && new Date(posted).getTime() < sinceMs) continue;
          notifications.push({
            notification_id: `ann_${t.id}`,
            course_id: courseId ?? '',
            course_code: meta?.code ?? '',
            course_name: meta?.name ?? '',
            kind: 'announcement',
            title: t.title ?? '(untitled announcement)',
            summary: stripHtml(t.message).slice(0, 280),
            url: t.html_url ?? t.url ?? '',
            posted_at: posted,
            labels: t.read_state === 'unread' ? ['unread'] : [],
          });
        }
      } catch (e) {
        notificationsOk = false;
        this.logger?.(`canvas-api: announcements failed: ${(e as Error).message}`);
        errors.notifications = { code: 'fetch_failed', message: (e as Error).message };
      }

      // Discussion topics per course (non-announcement threads).
      for (const course of courses) {
        try {
          const raw = await this.getAll<RawDiscussionTopic>(
            `/api/v1/courses/${course.course_id}/discussion_topics?per_page=100`,
          );
          const meta = courseNameById.get(course.course_id);
          for (const t of raw) {
            if (t.announcement) continue; // announcements handled above
            const posted = t.last_reply_at ?? t.posted_at ?? t.created_at ?? null;
            if (sinceMs && posted && new Date(posted).getTime() < sinceMs) continue;
            const labels: string[] = [];
            if (t.read_state === 'unread' || (t.unread_count ?? 0) > 0) labels.push('unread');
            notifications.push({
              notification_id: `disc_${t.id}`,
              course_id: course.course_id,
              course_code: meta?.code ?? course.code,
              course_name: meta?.name ?? course.name,
              kind: 'discussion',
              title: t.title ?? '(untitled discussion)',
              summary: stripHtml(t.message).slice(0, 280),
              url:
                t.html_url ??
                `${this.baseUrl}/courses/${course.course_id}/discussion_topics/${t.id}`,
              posted_at: posted,
              labels,
            });
          }
        } catch (e) {
          notificationsOk = false;
          this.logger?.(
            `canvas-api: discussions failed for course ${course.course_id}: ${(e as Error).message}`,
          );
          if (!errors.notifications) {
            errors.notifications = { code: 'fetch_failed', message: (e as Error).message };
          }
        }
      }
      sources_ok.notifications = notificationsOk;
    } else if (sources_ok.courses) {
      // No courses, nothing to fetch, but the call path succeeded.
      sources_ok.notifications = true;
    } else {
      errors.notifications = { code: 'skipped', message: 'courses fetch failed' };
    }

    if (opts.limits?.notifications !== undefined) {
      notifications.splice(opts.limits.notifications);
    }

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

  // Extract the numeric course id from a Canvas html_url like
  // https://school.instructure.com/courses/123/... -> "123".
  private courseIdFromUrl(url: string): string | undefined {
    const m = url.match(/\/courses\/(\d+)/);
    return m ? m[1] : undefined;
  }
}
