// src/digest/diff.ts
//
// Diff two snapshots (today vs yesterday) into a flat list of DiffEvents for
// Canvas. Assignments and notifications are diffed independently; each event
// carries a priority hint the composer uses to route it into
// action_required / this_week / what_changed / discovery sections.
//
// Identity:
//   - Canvas assignments: assignment_id
//   - Canvas notifications: notification_id
//
// Items with empty identity are skipped on both sides of the diff to avoid
// false NEW/REMOVED churn driven by parse-side gaps.

import type {
  CanvasAssignmentEnvelope,
  CanvasNotificationEnvelope,
  CanvasSnapshot,
} from '../sources/canvas-source.js';
import type { CanvasDigestPayload } from '../snapshot/format.js';

export type DiffPriority = 'urgent' | 'normal' | 'low';

export type DiffSource = 'canvas';

export type DiffEventKind = 'NEW' | 'GRADED' | 'DUE_DATE_CHANGED' | 'REMOVED';

export type DiffResourceType = 'assignment' | 'notification';

export interface DiffEvent {
  kind: DiffEventKind;
  source: DiffSource;
  resource_type: DiffResourceType;
  resource_id: string;
  title: string;
  url?: string;
  priority: DiffPriority;

  // Canvas course context kept on the event so the formatter can render it
  // without a back-reference to the snapshot.
  course_id?: string;
  course_code?: string;

  // Date-change fields (DUE_DATE_CHANGED).
  from_due_at?: string;
  to_due_at?: string;

  // Canvas notification kind (announcement / discussion / ...).
  notification_kind?: string;
}

// ---------- Canvas ----------

function indexAssignments(items: CanvasAssignmentEnvelope[]): Map<string, CanvasAssignmentEnvelope> {
  const idx = new Map<string, CanvasAssignmentEnvelope>();
  for (const a of items) if (a.assignment_id) idx.set(a.assignment_id, a);
  return idx;
}

function indexNotifications(items: CanvasNotificationEnvelope[]): Map<string, CanvasNotificationEnvelope> {
  const idx = new Map<string, CanvasNotificationEnvelope>();
  for (const n of items) if (n.notification_id) idx.set(n.notification_id, n);
  return idx;
}

function assignmentEvent(
  kind: 'NEW' | 'GRADED' | 'DUE_DATE_CHANGED' | 'REMOVED',
  a: CanvasAssignmentEnvelope,
  extra: Partial<DiffEvent> = {},
): DiffEvent {
  return {
    kind,
    source: 'canvas',
    resource_type: 'assignment',
    resource_id: a.assignment_id,
    course_id: a.course_id,
    course_code: a.course_code,
    title: a.title,
    url: a.url,
    priority: kind === 'GRADED' || kind === 'DUE_DATE_CHANGED' ? 'urgent' : 'normal',
    ...extra,
  };
}

function notificationEvent(
  kind: 'NEW' | 'REMOVED',
  n: CanvasNotificationEnvelope,
): DiffEvent {
  return {
    kind,
    source: 'canvas',
    resource_type: 'notification',
    resource_id: n.notification_id,
    course_id: n.course_id,
    course_code: n.course_code,
    title: n.title,
    url: n.url,
    priority: 'normal',
    notification_kind: n.kind,
  };
}

export function computeCanvasDiff(today: CanvasSnapshot, yesterday: CanvasSnapshot): DiffEvent[] {
  const events: DiffEvent[] = [];

  const tAssign = indexAssignments(today.assignments);
  const yAssign = indexAssignments(yesterday.assignments);

  for (const [id, t] of tAssign) {
    const prior = yAssign.get(id);
    if (!prior) {
      events.push(assignmentEvent('NEW', t));
      continue;
    }
    // GRADED fires only on transition to `graded`, not on plain `submitted`.
    // Conflating the two would call submitted-but-not-yet-graded work graded.
    if (prior.submission_status !== 'graded' && t.submission_status === 'graded') {
      events.push(assignmentEvent('GRADED', t));
    }
    // Treat any transition between dates - including null to date and date
    // to null - as a DUE_DATE_CHANGED. A removed due date matters to the
    // student just as much as a changed one. null to null is a no-op.
    if ((prior.due_at ?? null) !== (t.due_at ?? null)) {
      events.push(
        assignmentEvent('DUE_DATE_CHANGED', t, {
          from_due_at: prior.due_at ?? undefined,
          to_due_at: t.due_at ?? undefined,
        }),
      );
    }
  }
  for (const [id, prior] of yAssign) {
    if (!tAssign.has(id)) {
      events.push(assignmentEvent('REMOVED', prior));
    }
  }

  const tNotif = indexNotifications(today.notifications);
  const yNotif = indexNotifications(yesterday.notifications);

  for (const [id, t] of tNotif) {
    if (!yNotif.has(id)) events.push(notificationEvent('NEW', t));
  }
  for (const [id, prior] of yNotif) {
    if (!tNotif.has(id)) events.push(notificationEvent('REMOVED', prior));
  }

  return events;
}

// ---------- top-level orchestrator ----------

export function computeDiff(
  today: CanvasDigestPayload,
  yesterday: CanvasDigestPayload | null,
): DiffEvent[] {
  if (!yesterday) return [];
  return computeCanvasDiff(today.canvas, yesterday.canvas);
}
