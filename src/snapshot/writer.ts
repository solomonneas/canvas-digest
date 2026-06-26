// src/snapshot/writer.ts
//
// Render a CanvasDigestPayload as a markdown note with YAML frontmatter, a
// human-readable body grouped by course, and a fenced JSON tail that holds the
// full payload for the reader to round-trip.

import type {
  CanvasSnapshot,
  CanvasAssignmentEnvelope,
  CanvasNotificationEnvelope,
  CanvasCourseEnvelope,
} from '../sources/canvas-source.js';
import type { CanvasDigestPayload, SnapshotMeta } from './format.js';
import {
  JSON_TAIL_OPEN,
  JSON_TAIL_CLOSE,
  FRONTMATTER_DELIM,
  SNAPSHOT_VERSION_LINE,
} from './format.js';

function fmtCreatedDate(date: string): string {
  const [y, m, d] = date.split('-');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
  return `${y}-${month}-${d}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'no due date';
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return 'no due date';
  return dt.toLocaleDateString('en-CA');
}

function daysUntil(iso: string | null, from: Date): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - from.getTime()) / 86400000);
  if (days < 0) return ` (${Math.abs(days)}d overdue)`;
  if (days === 0) return ' (today)';
  return ` (in ${days}d)`;
}

function fmtAssignment(a: CanvasAssignmentEnvelope, now: Date): string {
  const due = fmtDate(a.due_at);
  const until = daysUntil(a.due_at, now);
  const pts = a.points_possible ?? 0;
  return `- **${due}${until}** ${a.title} - ${pts} pts - status: ${a.submission_status}`;
}

function fmtNotification(n: CanvasNotificationEnvelope): string {
  const when = fmtDate(n.posted_at);
  const labels = n.labels.length > 0 ? ` [${n.labels.join(', ')}]` : '';
  return `- **${when}** (${n.kind}) ${n.title}${labels}`;
}

function renderCourse(
  course: CanvasCourseEnvelope,
  assignments: CanvasAssignmentEnvelope[],
  notifications: CanvasNotificationEnvelope[],
  now: Date,
): string {
  const lines: string[] = [];
  const codeLabel = course.code || course.course_id;
  lines.push(`## ${codeLabel} - ${course.name}`);
  const term = course.term ?? 'Unknown';
  lines.push(`**Term:** ${term}`);

  if (assignments.length > 0) {
    lines.push('');
    lines.push(`### Assignments (${assignments.length})`);
    for (const a of assignments) lines.push(fmtAssignment(a, now));
  }
  if (notifications.length > 0) {
    lines.push('');
    lines.push(`### Notifications (${notifications.length})`);
    for (const n of notifications) lines.push(fmtNotification(n));
  }
  return lines.join('\n');
}

interface CourseBucket {
  course: CanvasCourseEnvelope;
  assignments: CanvasAssignmentEnvelope[];
  notifications: CanvasNotificationEnvelope[];
}

function bucketByCourse(snapshot: CanvasSnapshot): CourseBucket[] {
  const buckets = new Map<string, CourseBucket>();
  for (const c of snapshot.courses) {
    buckets.set(c.course_id, { course: c, assignments: [], notifications: [] });
  }

  const ensureBucket = (course_id: string, course_code: string, course_name: string): CourseBucket => {
    let b = buckets.get(course_id);
    if (!b) {
      b = {
        course: {
          course_id,
          code: course_code,
          name: course_name,
          term: null,
          url: '',
        },
        assignments: [],
        notifications: [],
      };
      buckets.set(course_id, b);
    }
    return b;
  };

  for (const a of snapshot.assignments) {
    const b = ensureBucket(a.course_id, a.course_code, a.course_name ?? a.course_code);
    b.assignments.push(a);
  }
  for (const n of snapshot.notifications) {
    const b = ensureBucket(n.course_id, n.course_code, n.course_name);
    b.notifications.push(n);
  }
  return [...buckets.values()].sort((x, y) => x.course.code.localeCompare(y.course.code));
}

export function writeSnapshot(payload: CanvasDigestPayload, meta: SnapshotMeta): string {
  const now = new Date(meta.generatedAt);
  const buckets = bucketByCourse(payload.canvas);
  const sourcesOk = payload.canvas.sources_ok;

  const frontmatterLines: string[] = [
    FRONTMATTER_DELIM,
    'tags:',
    '  - canvas-snapshot',
    `created: ${fmtCreatedDate(meta.date)}`,
    `date: ${meta.date}`,
    `courses: ${payload.canvas.courses.length}`,
    `assignments: ${payload.canvas.assignments.length}`,
    `notifications: ${payload.canvas.notifications.length}`,
    `sources_ok_courses: ${sourcesOk.courses}`,
    `sources_ok_assignments: ${sourcesOk.assignments}`,
    `sources_ok_notifications: ${sourcesOk.notifications}`,
    FRONTMATTER_DELIM,
  ];
  const frontmatter = frontmatterLines.join('\n');

  const intro =
    `\n${SNAPSHOT_VERSION_LINE}\n` +
    `\n> Canvas digest snapshot for ${meta.date}\n> Generated ${meta.generatedAt}\n`;

  const body = buckets
    .map((b) => renderCourse(b.course, b.assignments, b.notifications, now))
    .join('\n\n');

  const tail = `\n\n---\n${JSON_TAIL_OPEN}${JSON.stringify(payload, null, 2)}${JSON_TAIL_CLOSE}`;

  return `${frontmatter}\n${intro}\n${body}${tail}`;
}
