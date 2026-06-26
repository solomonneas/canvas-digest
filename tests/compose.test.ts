import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { composeDigest } from '../src/digest/compose.js';
import type { CanvasDigestPayload } from '../src/snapshot/format.js';

const day1 = JSON.parse(readFileSync('tests/fixtures/canvas-day-1.json', 'utf-8')) as CanvasDigestPayload;
const day2 = JSON.parse(readFileSync('tests/fixtures/canvas-day-2.json', 'utf-8')) as CanvasDigestPayload;

const NOW = new Date('2026-05-16T11:00:00Z');

describe('composeDigest', () => {
  test('all-empty payload returns isEmpty=true', () => {
    const empty: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [],
        assignments: [],
        notifications: [],
        by_course: [],
        sources_ok: { courses: true, assignments: true, notifications: true },
      },
    };
    const d = composeDigest(empty, null, '2026-05-16', { now: NOW });
    expect(d.isEmpty).toBe(true);
    expect(d.action_required.count).toBe(0);
    expect(d.this_week.count).toBe(0);
    expect(d.what_changed.count).toBe(0);
    expect(d.discovery.count).toBe(0);
    expect(d.diff_events).toEqual([]);
    expect(d.courses_count).toBe(0);
  });

  test('canvas assignment due in 1 day lands in action_required', () => {
    const d = composeDigest(day1, null, '2026-05-16', {
      now: new Date('2026-05-19T11:00:00Z'),
    });
    // 5001 is due 2026-05-20 -> 1 day out -> action_required
    const ar = d.action_required.items.find((i) => i.title === 'Module 1 Discussion Post');
    expect(ar).toBeDefined();
    expect(ar?.priority).toBe('urgent');
    expect(ar?.source).toBe('canvas');
  });

  test('canvas assignment due in 5 days lands in this_week', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    // 5001 is due 2026-05-20 -> ~4 days from NOW -> this_week
    const tw = d.this_week.items.find((i) => i.title === 'Module 1 Discussion Post');
    expect(tw).toBeDefined();
    expect(tw?.priority).toBe('normal');
  });

  test('graded canvas assignment never reappears in time-window sections', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    // 5000 is graded -> should not appear in either section
    const inAR = d.action_required.items.find((i) => i.title === 'Syllabus Acknowledgment');
    const inTW = d.this_week.items.find((i) => i.title === 'Syllabus Acknowledgment');
    expect(inAR).toBeUndefined();
    expect(inTW).toBeUndefined();
  });

  test('unread notifications land in this_week', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const note = d.this_week.items.find(
      (i) => i.kind === 'canvas_notification' && i.title === 'Welcome to EEL 6787',
    );
    expect(note).toBeDefined();
    expect(note?.source).toBe('canvas');
  });

  test('what_changed.count tracks diff_events length but items is empty', () => {
    const d = composeDigest(day2, day1, '2026-05-17', {
      now: new Date('2026-05-17T11:00:00Z'),
    });
    expect(d.diff_events.length).toBeGreaterThan(0);
    expect(d.what_changed.count).toBe(d.diff_events.length);
    expect(d.what_changed.items).toEqual([]);
  });

  test('assignment with no due date is not bucketed into time windows', () => {
    const payload: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [],
        assignments: [
          {
            assignment_id: 'A1',
            course_id: 'C1',
            course_code: 'X 1',
            kind: 'assignment',
            title: 'No due date assignment',
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
    const d = composeDigest(payload, null, '2026-05-16', { now: NOW });
    expect(d.action_required.count).toBe(0);
    expect(d.this_week.count).toBe(0);
  });

  test('sources_ok reflects the canvas snapshot flags', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    expect(d.sources_ok.canvas).toBe(true);

    const degraded: CanvasDigestPayload = {
      ...day1,
      canvas: {
        ...day1.canvas,
        sources_ok: { courses: true, assignments: false, notifications: true },
      },
    };
    const d2 = composeDigest(degraded, null, '2026-05-16', { now: NOW });
    expect(d2.sources_ok.canvas).toBe(false);
  });

  test('items within a section sort by priority then due date', () => {
    const payload: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [],
        assignments: [
          {
            assignment_id: 'A1',
            course_id: 'C1',
            course_code: 'X 1',
            kind: 'assignment',
            title: 'Later urgent',
            due_at: '2026-05-18T00:00:00Z', // 2 days out -> action_required
            due_at_local: '',
            points_possible: 10,
            submission_status: 'not_submitted',
            url: '',
          },
          {
            assignment_id: 'A2',
            course_id: 'C1',
            course_code: 'X 1',
            kind: 'assignment',
            title: 'Earlier urgent',
            due_at: '2026-05-17T00:00:00Z', // 1 day out -> action_required
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
    const d = composeDigest(payload, null, '2026-05-16', { now: NOW });
    expect(d.action_required.items.map((i) => i.title)).toEqual([
      'Earlier urgent',
      'Later urgent',
    ]);
  });

  test('isEmpty stays false if only what_changed has events', () => {
    const empty: CanvasDigestPayload = {
      fetched_at: '2026-05-17T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-17T11:00:00Z',
        courses: [],
        assignments: [],
        notifications: [],
        by_course: [],
        sources_ok: { courses: true, assignments: true, notifications: true },
      },
    };
    const d = composeDigest(day2, day1, '2026-05-17', {
      now: new Date('2026-05-17T11:00:00Z'),
    });
    expect(d.what_changed.count).toBeGreaterThan(0);
    expect(d.isEmpty).toBe(false);
    // sanity: empty diff against itself
    const dEmpty = composeDigest(empty, empty, '2026-05-17', {
      now: new Date('2026-05-17T11:00:00Z'),
    });
    expect(dEmpty.isEmpty).toBe(true);
  });
});
