// src/sources/canvas-source.ts
//
// This file defines the internal Canvas data model (CanvasSnapshot and its
// envelopes) that the whole digest pipeline consumes, plus the optional
// browser-bridge-backed Canvas source.
//
// CanvasSource is a facade over BrowserBridgeRunner: a FALLBACK source for
// schools that block Canvas API access tokens. The default source is the
// Canvas REST API (see canvas-api.ts), which produces the same CanvasSnapshot.
//
// CanvasSource invokes the three browser-bridge adapter actions (list-courses,
// list-upcoming-assignments, list-recent-notifications) sequentially because a
// single Chrome profile lock is non-reentrant - parallel calls collide with
// `profile_locked`. It records per-action ok/error state and never throws; it
// returns a CanvasSnapshot with partial data when individual actions fail.

import type { BrowserBridgeRunner, BrowserBridgeError } from './browser-bridge.js';
import { DEFAULT_PROFILE_NAME } from './browser-bridge.js';

export interface CanvasCourseEnvelope {
  course_id: string;
  code: string;
  name: string;
  term: string | null;
  role?: string;
  url: string;
}

export interface CanvasAssignmentEnvelope {
  assignment_id: string;
  course_id: string;
  course_code: string;
  course_name?: string;
  kind: string;
  title: string;
  due_at: string | null;
  due_at_local: string;
  points_possible: number | null;
  submission_status: string;
  url: string;
  labels?: string[];
}

export interface CanvasNotificationEnvelope {
  notification_id: string;
  course_id: string;
  course_code: string;
  course_name: string;
  kind: string;
  title: string;
  summary: string;
  url: string;
  posted_at: string | null;
  labels: string[];
}

export interface CanvasByCourseEnvelope {
  course_id: string;
  course_code: string;
  course_name: string;
  count: number;
}

export interface CanvasSourcesOk {
  courses: boolean;
  assignments: boolean;
  notifications: boolean;
}

export interface CanvasSourceErrors {
  courses?: BrowserBridgeError;
  assignments?: BrowserBridgeError;
  notifications?: BrowserBridgeError;
}

export interface CanvasSnapshot {
  fetched_at: string;
  courses: CanvasCourseEnvelope[];
  assignments: CanvasAssignmentEnvelope[];
  notifications: CanvasNotificationEnvelope[];
  by_course: CanvasByCourseEnvelope[];
  sources_ok: CanvasSourcesOk;
  errors?: CanvasSourceErrors;
}

export interface CanvasFetchOptions {
  lookahead_days?: number;
  since?: Date;
  limits?: {
    courses?: number;
    assignments?: number;
    notifications?: number;
  };
}

export interface CanvasSourceOptions {
  runner: BrowserBridgeRunner;
  profileName?: string;
  timeoutMs?: number;
}

interface ListCoursesResult {
  courses?: unknown;
  scanned_count?: number;
}

interface ListAssignmentsResult {
  assignments?: unknown;
  scanned_count?: number;
  by_course?: unknown;
}

interface ListNotificationsResult {
  notifications?: unknown;
  scanned_count?: number;
  has_more?: boolean;
  last_seen_at?: string | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export class CanvasSource {
  private readonly runner: BrowserBridgeRunner;
  private readonly profileName: string;
  private readonly timeoutMs?: number;

  constructor(opts: CanvasSourceOptions) {
    this.runner = opts.runner;
    this.profileName = opts.profileName ?? DEFAULT_PROFILE_NAME;
    this.timeoutMs = opts.timeoutMs;
  }

  async fetch(opts: CanvasFetchOptions = {}): Promise<CanvasSnapshot> {
    const fetched_at = new Date().toISOString();

    const coursesInput: Record<string, unknown> = {};
    if (opts.limits?.courses !== undefined) coursesInput.limit = opts.limits.courses;

    const assignmentsInput: Record<string, unknown> = {};
    if (opts.lookahead_days !== undefined) assignmentsInput.lookahead_days = opts.lookahead_days;
    if (opts.limits?.assignments !== undefined) assignmentsInput.limit = opts.limits.assignments;

    const notificationsInput: Record<string, unknown> = {};
    if (opts.since) notificationsInput.since = opts.since.toISOString();
    if (opts.limits?.notifications !== undefined) notificationsInput.limit = opts.limits.notifications;

    // Serialize the three calls. The browser-bridge profile lock is
    // non-reentrant, so parallel invocations of the same profile collide
    // and two of three return `profile_locked`.
    // Sequential adds a few seconds of wall clock but keeps all three calls
    // healthy. Each invoke promise is wrapped via try/await/catch into the
    // PromiseSettledResult shape downstream code already expects.
    const settle = async <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> => {
      try {
        return { status: 'fulfilled', value: await p };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    };

    const coursesEnv = await settle(
      this.runner.invoke<ListCoursesResult>({
        platform: 'canvas',
        action: 'list-courses',
        input: coursesInput,
        profileName: this.profileName,
        timeoutMs: this.timeoutMs,
      }),
    );
    const assignmentsEnv = await settle(
      this.runner.invoke<ListAssignmentsResult>({
        platform: 'canvas',
        action: 'list-upcoming-assignments',
        input: assignmentsInput,
        profileName: this.profileName,
        timeoutMs: this.timeoutMs,
      }),
    );
    const notificationsEnv = await settle(
      this.runner.invoke<ListNotificationsResult>({
        platform: 'canvas',
        action: 'list-recent-notifications',
        input: notificationsInput,
        profileName: this.profileName,
        timeoutMs: this.timeoutMs,
      }),
    );

    const errors: CanvasSourceErrors = {};
    const sources_ok: CanvasSourcesOk = {
      courses: false,
      assignments: false,
      notifications: false,
    };

    let courses: CanvasCourseEnvelope[] = [];
    if (coursesEnv.status === 'fulfilled' && coursesEnv.value.ok) {
      courses = asArray<CanvasCourseEnvelope>(coursesEnv.value.result?.courses);
      sources_ok.courses = true;
    } else if (coursesEnv.status === 'fulfilled') {
      errors.courses = coursesEnv.value.error ?? { code: 'unknown', message: '' };
    } else {
      errors.courses = { code: 'rejected', message: String(coursesEnv.reason) };
    }

    let assignments: CanvasAssignmentEnvelope[] = [];
    let by_course: CanvasByCourseEnvelope[] = [];
    if (assignmentsEnv.status === 'fulfilled' && assignmentsEnv.value.ok) {
      assignments = asArray<CanvasAssignmentEnvelope>(assignmentsEnv.value.result?.assignments);
      by_course = asArray<CanvasByCourseEnvelope>(assignmentsEnv.value.result?.by_course);
      sources_ok.assignments = true;
    } else if (assignmentsEnv.status === 'fulfilled') {
      errors.assignments = assignmentsEnv.value.error ?? { code: 'unknown', message: '' };
    } else {
      errors.assignments = { code: 'rejected', message: String(assignmentsEnv.reason) };
    }

    let notifications: CanvasNotificationEnvelope[] = [];
    if (notificationsEnv.status === 'fulfilled' && notificationsEnv.value.ok) {
      notifications = asArray<CanvasNotificationEnvelope>(
        notificationsEnv.value.result?.notifications,
      );
      sources_ok.notifications = true;
    } else if (notificationsEnv.status === 'fulfilled') {
      errors.notifications = notificationsEnv.value.error ?? { code: 'unknown', message: '' };
    } else {
      errors.notifications = { code: 'rejected', message: String(notificationsEnv.reason) };
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
}
