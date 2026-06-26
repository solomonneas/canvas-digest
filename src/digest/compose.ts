// src/digest/compose.ts
//
// Assemble a Digest from a fresh CanvasDigestPayload (today) and an optional
// prior payload (yesterday). The Digest layout emits four sections:
//
//   action_required - items demanding attention NOW. Assignments due in
//                     <=2 days (and unsubmitted).
//   this_week       - upcoming deadlines + unread notifications in the window.
//   what_changed    - the diff events (NEW / GRADED / DUE_DATE_CHANGED /
//                     REMOVED). Rendered straight from diff_events.
//   discovery       - lower-priority breadth (currently unused for Canvas-only;
//                     kept for layout symmetry and future sources).
//
// A digest is `isEmpty` only if all four sections have zero items/events.

import type {
  CanvasAssignmentEnvelope,
  CanvasNotificationEnvelope,
} from '../sources/canvas-source.js';
import type { CanvasDigestPayload } from '../snapshot/format.js';
import { computeDiff } from './diff.js';
import type { DiffEvent, DiffPriority } from './diff.js';

export type DigestSourceKey = 'canvas';

export interface DigestItem {
  title: string;
  summary?: string;
  url?: string;
  source: DigestSourceKey;
  category?: string;
  due_at?: string;
  priority: DiffPriority;
  // Internal kind tag used by formatters for source-specific glyphs.
  kind: 'canvas_assignment' | 'canvas_notification';
  // Canvas assignment submission status pass-through so the formatter can
  // render an urgency emoji without re-walking the snapshot.
  canvas_submission_status?: string;
}

export interface DigestSection {
  items: DigestItem[];
  count: number;
}

export interface DigestSourcesOk {
  canvas: boolean;
}

export interface Digest {
  date: string;
  fetched_at: string;
  isEmpty: boolean;
  sources_ok: DigestSourcesOk;
  action_required: DigestSection;
  this_week: DigestSection;
  what_changed: DigestSection;
  discovery: DigestSection;

  // Carried metadata so the formatter and CLI status line can render a header
  // without re-walking the payload.
  diff_events: DiffEvent[];
  courses_count: number;
}

// ---------- helpers ----------

const ONE_DAY_MS = 86400000;

function dueMs(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function postedMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function emptySection(): DigestSection {
  return { items: [], count: 0 };
}

function finalize(section: DigestSection): DigestSection {
  return { items: section.items, count: section.items.length };
}

// ---------- per-source item builders ----------

export function kindEmoji(kind: string | undefined): string {
  switch (kind) {
    case 'assignment': return '📝';
    case 'quiz': return '📊';
    case 'discussion': return '💬';
    case 'discussion_topic': return '💬';
    case 'discussion_reply': return '💬';
    case 'online_quiz': return '📊';
    case 'announcement': return '📣';
    case 'grade_posted': return '🎓';
    case 'feedback': return '💡';
    default: return '📄';
  }
}

export function statusEmoji(submissionStatus: string | undefined): string {
  switch (submissionStatus) {
    case 'graded': return '✅';
    case 'submitted': return '☑️';
    case 'late': return '🔴';
    case 'missing': return '🔴';
    case 'not_submitted': return '⚠️';
    default: return '';
  }
}

function assignmentItem(a: CanvasAssignmentEnvelope, priority: DiffPriority): DigestItem {
  const points = a.points_possible !== null && a.points_possible !== undefined
    ? `${a.points_possible} pts`
    : '';
  const due = a.due_at_local ? `Due ${a.due_at_local}` : '';
  const courseLine = a.course_name
    ? `${a.course_name} (${a.course_code})`
    : a.course_code;
  const statusLabel = a.submission_status ? a.submission_status.replace(/_/g, ' ') : '';
  // Two-line summary: course + due/points on top, status on bottom. Formatters
  // render kind/status emoji from category + canvas_submission_status fields.
  const headerBits = [courseLine, points && `· ${points}`].filter(Boolean).join(' ');
  const statusBits = [due, statusLabel && `· ${statusLabel}`].filter(Boolean).join(' ');
  return {
    kind: 'canvas_assignment',
    source: 'canvas',
    title: a.title,
    summary: [headerBits, statusBits].filter(Boolean).join('\n'),
    url: a.url,
    due_at: a.due_at ?? undefined,
    priority,
    category: a.kind,
    canvas_submission_status: a.submission_status,
  };
}

function notificationItem(n: CanvasNotificationEnvelope): DigestItem {
  const courseLine = n.course_name
    ? `${n.course_name} (${n.course_code})`
    : n.course_code;
  const kindLabel = n.kind ? n.kind.replace(/_/g, ' ') : 'notification';
  return {
    kind: 'canvas_notification',
    source: 'canvas',
    title: n.title,
    summary: `${courseLine} · ${kindLabel}`,
    url: n.url,
    due_at: n.posted_at ?? undefined,
    priority: 'normal',
    category: n.kind,
  };
}

// ---------- composer ----------

export interface ComposeOptions {
  // Override the "now" anchor used to bucket things into action_required vs
  // this_week vs discovery. Defaults to today.fetched_at.
  now?: Date;
}

export function composeDigest(
  today: CanvasDigestPayload,
  yesterday: CanvasDigestPayload | null,
  date: string,
  options: ComposeOptions = {},
): Digest {
  const diff_events = computeDiff(today, yesterday);
  const now = options.now ?? new Date(today.fetched_at);
  const nowMs = now.getTime();
  const inDays = (ms: number): number => Math.ceil((ms - nowMs) / ONE_DAY_MS);

  const action_required: DigestSection = emptySection();
  const this_week: DigestSection = emptySection();
  const what_changed: DigestSection = emptySection();
  const discovery: DigestSection = emptySection();

  // -------- Canvas assignments --------
  // School deadlines are never discovery. Anything within the lookahead window
  // lands in either action_required (due today/tomorrow) or this_week.
  const canvas = today.canvas;
  for (const a of canvas.assignments) {
    const due = dueMs(a.due_at);
    if (!Number.isFinite(due)) {
      // No due date: skip the time-window buckets. Counted in `what_changed`
      // via diff events when applicable, otherwise stays out of the brief.
      continue;
    }
    const days = inDays(due);
    if (a.submission_status === 'graded' || a.submission_status === 'submitted') continue;
    if (days <= 2 && days >= -1) {
      // -1 covers an assignment due yesterday that hasn't been graded yet.
      action_required.items.push(assignmentItem(a, 'urgent'));
    } else if (days >= 0) {
      // Anything else in window: trust whatever Canvas returned and surface it.
      this_week.items.push(assignmentItem(a, 'normal'));
    }
  }

  // -------- Canvas notifications --------
  // Surface unread announcements/discussions. Treat `unread` as the signal;
  // gate undated items in (over-include) and recent dated items within 14 days.
  for (const n of canvas.notifications) {
    if (!n.labels?.includes('unread')) continue;
    const posted = postedMs(n.posted_at);
    const hasDate = posted > 0;
    const ageDays = hasDate ? (nowMs - posted) / ONE_DAY_MS : 0;
    if (!hasDate || ageDays <= 14) {
      this_week.items.push(notificationItem(n));
    }
  }

  // -------- what_changed --------
  // The formatter walks digest.diff_events directly and groups by source. We
  // keep what_changed.items empty by design; its count tracks diff events.
  what_changed.items = [];

  // -------- sort each section by priority then by due_at --------
  const PRIORITY_RANK: Record<DiffPriority, number> = { urgent: 0, normal: 1, low: 2 };
  const sortSection = (s: DigestSection): void => {
    s.items.sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority];
      const pb = PRIORITY_RANK[b.priority];
      if (pa !== pb) return pa - pb;
      const da = dueMs(a.due_at);
      const db = dueMs(b.due_at);
      return da - db;
    });
  };
  sortSection(action_required);
  sortSection(this_week);
  sortSection(discovery);

  const sources_ok: DigestSourcesOk = {
    canvas:
      canvas.sources_ok.courses &&
      canvas.sources_ok.assignments &&
      canvas.sources_ok.notifications,
  };

  const finalized = {
    action_required: finalize(action_required),
    this_week: finalize(this_week),
    what_changed: {
      items: what_changed.items,
      count: diff_events.length,
    } as DigestSection,
    discovery: finalize(discovery),
  };

  const isEmpty =
    finalized.action_required.count === 0 &&
    finalized.this_week.count === 0 &&
    finalized.what_changed.count === 0 &&
    finalized.discovery.count === 0;

  return {
    date,
    fetched_at: today.fetched_at,
    isEmpty,
    sources_ok,
    courses_count: canvas.courses.length,
    diff_events,
    ...finalized,
  };
}
