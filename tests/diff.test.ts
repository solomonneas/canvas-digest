import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeDiff, computeCanvasDiff } from '../src/digest/diff.js';
import type { CanvasDigestPayload } from '../src/snapshot/format.js';

const day1 = JSON.parse(readFileSync('tests/fixtures/canvas-day-1.json', 'utf-8')) as CanvasDigestPayload;
const day2 = JSON.parse(readFileSync('tests/fixtures/canvas-day-2.json', 'utf-8')) as CanvasDigestPayload;

describe('computeDiff', () => {
  test('returns empty when no prior snapshot', () => {
    const events = computeDiff(day2, null);
    expect(events).toEqual([]);
  });

  test('detects NEW assignment', () => {
    const events = computeDiff(day2, day1);
    const evt = events.find((e) => e.kind === 'NEW' && e.resource_type === 'assignment' && e.resource_id === '5002');
    expect(evt).toMatchObject({
      kind: 'NEW',
      resource_type: 'assignment',
      course_code: 'EEL 6787',
      title: 'Module 1 Lab Report',
    });
  });

  test('detects DUE_DATE_CHANGED on existing assignment', () => {
    const events = computeDiff(day2, day1);
    const evt = events.find((e) => e.kind === 'DUE_DATE_CHANGED' && e.resource_id === '5001');
    expect(evt).toMatchObject({
      kind: 'DUE_DATE_CHANGED',
      from_due_at: '2026-05-20T23:59:00Z',
      to_due_at: '2026-05-21T23:59:00Z',
    });
  });

  test('detects NEW notification (announcement)', () => {
    const events = computeDiff(day2, day1);
    const evt = events.find(
      (e) => e.kind === 'NEW' && e.resource_type === 'notification' && e.resource_id === '7002',
    );
    expect(evt).toMatchObject({
      kind: 'NEW',
      resource_type: 'notification',
      notification_kind: 'announcement',
    });
  });

  test('detects NEW notification for a follow-up discussion reply', () => {
    const events = computeDiff(day2, day1);
    const evt = events.find(
      (e) => e.kind === 'NEW' && e.resource_type === 'notification' && e.resource_id === '432-r2',
    );
    expect(evt).toMatchObject({ notification_kind: 'discussion_reply' });
  });

  test('detects REMOVED notifications no longer present today', () => {
    const events = computeDiff(day2, day1);
    const evt = events.find((e) => e.kind === 'REMOVED' && e.resource_id === '432-r1');
    expect(evt).toMatchObject({ resource_type: 'notification' });
  });

  test('does NOT emit GRADED for not_submitted -> submitted (only -> graded)', () => {
    const before: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [],
        assignments: [
          {
            assignment_id: 'A2',
            course_id: 'C1',
            course_code: 'X 1',
            kind: 'online_upload',
            title: 'Lab 2',
            due_at: null,
            due_at_local: '',
            points_possible: 20,
            submission_status: 'not_submitted',
            url: '',
          },
        ],
        notifications: [],
        by_course: [],
        sources_ok: { courses: true, assignments: true, notifications: true },
      },
    };
    const after: CanvasDigestPayload = JSON.parse(JSON.stringify(before)) as CanvasDigestPayload;
    after.canvas.assignments[0].submission_status = 'submitted';
    const events = computeDiff(after, before);
    expect(events.find((e) => e.kind === 'GRADED')).toBeUndefined();
  });

  test('detects GRADED on submission_status transition to graded', () => {
    const before: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [],
        assignments: [
          {
            assignment_id: 'A1',
            course_id: 'C1',
            course_code: 'X 1',
            kind: 'online_text_entry',
            title: 'Quiz 1',
            due_at: null,
            due_at_local: '',
            points_possible: 10,
            submission_status: 'not_submitted',
            url: '',
          },
        ],
        notifications: [],
        by_course: [],
        sources_ok: { courses: true, assignments: true, notifications: true },
      },
    };
    const after: CanvasDigestPayload = JSON.parse(JSON.stringify(before)) as CanvasDigestPayload;
    after.canvas.assignments[0].submission_status = 'graded';
    const events = computeDiff(after, before);
    const evt = events.find((e) => e.kind === 'GRADED' && e.resource_id === 'A1');
    expect(evt).toBeDefined();
  });

  test('detects REMOVED assignment', () => {
    const events = computeDiff(day1, day2);
    const evt = events.find(
      (e) => e.kind === 'REMOVED' && e.resource_type === 'assignment' && e.resource_id === '5002',
    );
    expect(evt).toBeDefined();
  });

  test('all canvas events tagged with source=canvas', () => {
    const events = computeDiff(day2, day1);
    for (const e of events) expect(e.source).toBe('canvas');
  });

  test('GRADED/DUE_DATE_CHANGED carry urgent priority, plain NEW does not', () => {
    const events = computeDiff(day2, day1);
    const newAssign = events.find((e) => e.kind === 'NEW' && e.resource_id === '5002');
    expect(newAssign?.priority).toBe('normal');
    const dueChange = events.find((e) => e.kind === 'DUE_DATE_CHANGED');
    expect(dueChange?.priority).toBe('urgent');
  });

  test('computeCanvasDiff can be called directly on two snapshots', () => {
    const events = computeCanvasDiff(day2.canvas, day1.canvas);
    expect(events.some((e) => e.kind === 'NEW')).toBe(true);
  });
});
