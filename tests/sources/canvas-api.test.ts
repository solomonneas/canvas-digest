import { describe, test, expect } from 'vitest';
import { CanvasApiSource } from '../../src/sources/canvas-api.js';

// A tiny fetch fake that routes by URL path. Each handler returns a
// { status, body, link } triple; the source reads JSON + the Link header.
interface Route {
  match: (url: string) => boolean;
  status?: number;
  body: unknown;
  link?: string;
}

function makeFetch(routes: Route[]): { fetchImpl: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (route.link) headers['link'] = route.link;
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers,
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const BASE = 'https://your-school.instructure.com';

describe('CanvasApiSource.fetch', () => {
  test('maps courses, assignments, announcements, and discussions into a CanvasSnapshot', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.includes('/api/v1/courses?enrollment_state=active'),
        body: [
          {
            id: 1001,
            name: 'Data Networks',
            course_code: 'EEL 6787',
            term: { name: 'Summer 2026' },
            enrollments: [{ type: 'StudentEnrollment', role: 'StudentEnrollment' }],
          },
        ],
      },
      {
        match: (u) => u.includes('/courses/1001/assignments'),
        body: [
          {
            id: 5001,
            name: 'Module 1 Lab',
            due_at: '2026-05-21T23:59:00Z',
            points_possible: 50,
            html_url: `${BASE}/courses/1001/assignments/5001`,
            submission_types: ['online_upload'],
            submission: { workflow_state: 'graded', graded_at: '2026-05-20T00:00:00Z' },
          },
        ],
      },
      {
        match: (u) => u.includes('/api/v1/announcements'),
        body: [
          {
            id: 7001,
            title: 'Welcome',
            message: '<p>Welcome to the course &amp; good luck</p>',
            html_url: `${BASE}/courses/1001/discussion_topics/7001`,
            posted_at: '2026-05-15T13:00:00Z',
            read_state: 'unread',
            announcement: true,
          },
        ],
      },
      {
        match: (u) => u.includes('/courses/1001/discussion_topics'),
        body: [
          {
            id: 432,
            title: 'Intro Thread',
            message: 'Say hi',
            html_url: `${BASE}/courses/1001/discussion_topics/432`,
            last_reply_at: '2026-05-16T09:15:00Z',
            unread_count: 2,
            announcement: false,
          },
        ],
      },
    ]);

    const source = new CanvasApiSource({ baseUrl: BASE, token: 'tok', fetchImpl });
    const snap = await source.fetch({ lookahead_days: 14 });

    expect(snap.sources_ok).toEqual({ courses: true, assignments: true, notifications: true });
    expect(snap.errors).toBeUndefined();

    expect(snap.courses).toHaveLength(1);
    expect(snap.courses[0]).toMatchObject({
      course_id: '1001',
      code: 'EEL 6787',
      name: 'Data Networks',
      term: 'Summer 2026',
      url: `${BASE}/courses/1001`,
    });

    expect(snap.assignments).toHaveLength(1);
    expect(snap.assignments[0]).toMatchObject({
      assignment_id: '5001',
      course_id: '1001',
      course_code: 'EEL 6787',
      title: 'Module 1 Lab',
      due_at: '2026-05-21T23:59:00Z',
      points_possible: 50,
      submission_status: 'graded',
      kind: 'online_upload',
    });
    expect(snap.by_course).toEqual([
      { course_id: '1001', course_code: 'EEL 6787', course_name: 'Data Networks', count: 1 },
    ]);

    // One announcement + one discussion.
    const kinds = snap.notifications.map((n) => n.kind).sort();
    expect(kinds).toEqual(['announcement', 'discussion']);
    const ann = snap.notifications.find((n) => n.kind === 'announcement');
    expect(ann).toMatchObject({
      notification_id: 'ann_7001',
      course_id: '1001',
      title: 'Welcome',
      labels: ['unread'],
    });
    // HTML is stripped and entities decoded in the summary.
    expect(ann?.summary).toBe('Welcome to the course & good luck');
    const disc = snap.notifications.find((n) => n.kind === 'discussion');
    expect(disc).toMatchObject({ notification_id: 'disc_432', labels: ['unread'] });
  });

  test('submission status maps from workflow_state and flags', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.includes('/api/v1/courses?enrollment_state=active'),
        body: [{ id: 1, course_code: 'X', name: 'X', enrollments: [] }],
      },
      {
        match: (u) => u.includes('/courses/1/assignments'),
        body: [
          { id: 1, name: 'Unsubmitted', submission: null },
          { id: 2, name: 'Late', submission: { late: true, workflow_state: 'submitted' } },
          { id: 3, name: 'Missing', submission: { missing: true } },
          { id: 4, name: 'Submitted', submission: { workflow_state: 'submitted', submitted_at: '2026-05-10T00:00:00Z' } },
        ],
      },
      { match: (u) => u.includes('/api/v1/announcements'), body: [] },
      { match: (u) => u.includes('/courses/1/discussion_topics'), body: [] },
    ]);
    const source = new CanvasApiSource({ baseUrl: BASE, token: 'tok', fetchImpl });
    const snap = await source.fetch();
    const byTitle = Object.fromEntries(snap.assignments.map((a) => [a.title, a.submission_status]));
    expect(byTitle).toEqual({
      Unsubmitted: 'not_submitted',
      Late: 'late',
      Missing: 'missing',
      Submitted: 'submitted',
    });
  });

  test('follows the Link rel="next" header for pagination', async () => {
    const page2 = `${BASE}/api/v1/courses?page=2`;
    const { fetchImpl, calls } = makeFetch([
      {
        match: (u) => u.includes('/api/v1/courses?enrollment_state=active'),
        body: [{ id: 1, course_code: 'A', name: 'A', enrollments: [] }],
        link: `<${page2}>; rel="next", <${page2}>; rel="last"`,
      },
      {
        match: (u) => u === page2,
        body: [{ id: 2, course_code: 'B', name: 'B', enrollments: [] }],
      },
      { match: (u) => u.includes('/assignments'), body: [] },
      { match: (u) => u.includes('/api/v1/announcements'), body: [] },
      { match: (u) => u.includes('/discussion_topics'), body: [] },
    ]);
    const source = new CanvasApiSource({ baseUrl: BASE, token: 'tok', fetchImpl });
    const snap = await source.fetch();
    expect(snap.courses.map((c) => c.code)).toEqual(['A', 'B']);
    expect(calls).toContain(page2);
  });

  test('records a per-section error and degrades when courses fetch fails', async () => {
    const { fetchImpl } = makeFetch([
      {
        match: (u) => u.includes('/api/v1/courses?enrollment_state=active'),
        status: 401,
        body: { errors: [{ message: 'Invalid access token' }] },
      },
    ]);
    const source = new CanvasApiSource({ baseUrl: BASE, token: 'bad', fetchImpl });
    const snap = await source.fetch();
    expect(snap.sources_ok.courses).toBe(false);
    expect(snap.courses).toEqual([]);
    expect(snap.errors?.courses?.code).toBe('fetch_failed');
    expect(snap.errors?.courses?.message).toContain('401');
  });

  test('sets Bearer Authorization header on requests', async () => {
    let authHeader = '';
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeader = headers.get('authorization') ?? '';
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const source = new CanvasApiSource({ baseUrl: BASE, token: 'secret-token', fetchImpl });
    await source.fetch();
    expect(authHeader).toBe('Bearer secret-token');
  });
});
