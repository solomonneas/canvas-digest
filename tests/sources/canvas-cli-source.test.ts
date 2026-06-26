import { describe, test, expect } from 'vitest';
import {
  CanvasCliSource,
  CanvasCliUnavailableError,
  type CanvasCliRunner,
  type CanvasCliRunResult,
} from '../../src/sources/canvas-cli-source.js';

// A fake runner that routes by the subcommand (args[0]) and records the exact
// argv each invocation received, so we can assert flags without spawning a real
// canvas-cli binary.
function makeRunner(
  handlers: Record<string, () => CanvasCliRunResult>,
): { runner: CanvasCliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CanvasCliRunner = {
    async run(args: string[]): Promise<CanvasCliRunResult> {
      calls.push(args);
      const section = args[0];
      const handler = handlers[section];
      if (!handler) {
        return { ok: false, stdout: '', stderr: `no handler for ${section}`, code: 1 };
      }
      return handler();
    },
  };
  return { runner, calls };
}

const COURSES_JSON = JSON.stringify([
  {
    course_id: '1001',
    code: 'EEL 6787',
    name: 'Data Networks',
    term: 'Summer 2026',
    role: 'StudentEnrollment',
    url: 'https://school.instructure.com/courses/1001',
  },
]);

const ITEMS_JSON = JSON.stringify({
  assignments: [
    {
      assignment_id: '5001',
      course_id: '1001',
      course_code: 'EEL 6787',
      course_name: 'Data Networks',
      kind: 'online_upload',
      title: 'Module 1 Lab',
      due_at: '2026-05-21T23:59:00Z',
      due_at_local: 'May 21, 2026, 11:59 PM',
      points_possible: 50,
      submission_status: 'graded',
      url: 'https://school.instructure.com/courses/1001/assignments/5001',
      labels: ['graded'],
    },
  ],
  notifications: [
    {
      notification_id: 'ann_7001',
      course_id: '1001',
      course_code: 'EEL 6787',
      course_name: 'Data Networks',
      kind: 'announcement',
      title: 'Welcome',
      summary: 'Welcome to the course',
      url: 'https://school.instructure.com/courses/1001/announcements/7001',
      posted_at: '2026-05-15T13:00:00Z',
      labels: ['unread'],
    },
    {
      notification_id: 'disc_432',
      course_id: '1001',
      course_code: 'EEL 6787',
      course_name: 'Data Networks',
      kind: 'discussion',
      title: 'Intro Thread',
      summary: 'Say hi',
      url: 'https://school.instructure.com/courses/1001/discussion_topics/432',
      posted_at: '2026-05-16T09:15:00Z',
      labels: [],
    },
  ],
});

describe('CanvasCliSource.fetch', () => {
  test('maps canvas-cli courses + items JSON into a CanvasSnapshot', async () => {
    const { runner } = makeRunner({
      courses: () => ({ ok: true, stdout: COURSES_JSON, stderr: '', code: 0 }),
      items: () => ({ ok: true, stdout: ITEMS_JSON, stderr: '', code: 0 }),
    });

    const source = new CanvasCliSource({ runner });
    const snap = await source.fetch({ lookahead_days: 14 });

    expect(snap.sources_ok).toEqual({ courses: true, assignments: true, notifications: true });
    expect(snap.errors).toBeUndefined();

    expect(snap.courses).toHaveLength(1);
    expect(snap.courses[0]).toMatchObject({
      course_id: '1001',
      code: 'EEL 6787',
      name: 'Data Networks',
      term: 'Summer 2026',
      role: 'StudentEnrollment',
      url: 'https://school.instructure.com/courses/1001',
    });

    expect(snap.assignments).toHaveLength(1);
    expect(snap.assignments[0]).toMatchObject({
      assignment_id: '5001',
      course_id: '1001',
      course_code: 'EEL 6787',
      title: 'Module 1 Lab',
      due_at: '2026-05-21T23:59:00Z',
      due_at_local: 'May 21, 2026, 11:59 PM',
      points_possible: 50,
      submission_status: 'graded',
      kind: 'online_upload',
      labels: ['graded'],
    });

    const kinds = snap.notifications.map((n) => n.kind).sort();
    expect(kinds).toEqual(['announcement', 'discussion']);
    expect(snap.notifications.find((n) => n.kind === 'announcement')).toMatchObject({
      notification_id: 'ann_7001',
      labels: ['unread'],
    });

    // by_course is derived from the assignments + courses join.
    expect(snap.by_course).toEqual([
      { course_id: '1001', course_code: 'EEL 6787', course_name: 'Data Networks', count: 1 },
    ]);
  });

  test('passes --json, --base-url, --profile and --lookahead through to canvas-cli', async () => {
    const { runner, calls } = makeRunner({
      courses: () => ({ ok: true, stdout: '[]', stderr: '', code: 0 }),
      items: () => ({ ok: true, stdout: '{"assignments":[],"notifications":[]}', stderr: '', code: 0 }),
    });

    const source = new CanvasCliSource({
      runner,
      baseUrl: 'https://school.instructure.com/',
      profileName: 'default',
    });
    await source.fetch({ lookahead_days: 21 });

    const coursesCall = calls.find((c) => c[0] === 'courses');
    const itemsCall = calls.find((c) => c[0] === 'items');
    expect(coursesCall).toEqual([
      'courses',
      'list',
      '--json',
      '--base-url',
      'https://school.instructure.com', // trailing slash normalized off
      '--profile',
      'default',
    ]);
    expect(itemsCall).toEqual([
      'items',
      'list',
      '--json',
      '--base-url',
      'https://school.instructure.com',
      '--profile',
      'default',
      '--lookahead',
      '21',
    ]);
  });

  test('filters notifications older than `since`', async () => {
    const { runner } = makeRunner({
      courses: () => ({ ok: true, stdout: COURSES_JSON, stderr: '', code: 0 }),
      items: () => ({ ok: true, stdout: ITEMS_JSON, stderr: '', code: 0 }),
    });
    const source = new CanvasCliSource({ runner });
    // Cut off after the first announcement (2026-05-15) but before the
    // discussion (2026-05-16): only the discussion should survive.
    const snap = await source.fetch({ since: new Date('2026-05-16T00:00:00Z') });
    expect(snap.notifications.map((n) => n.notification_id)).toEqual(['disc_432']);
  });

  test('applies limits to each section', async () => {
    const manyCourses = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        course_id: String(i),
        code: `C${i}`,
        name: `Course ${i}`,
        term: null,
        url: '',
      })),
    );
    const { runner } = makeRunner({
      courses: () => ({ ok: true, stdout: manyCourses, stderr: '', code: 0 }),
      items: () => ({ ok: true, stdout: ITEMS_JSON, stderr: '', code: 0 }),
    });
    const source = new CanvasCliSource({ runner });
    const snap = await source.fetch({ limits: { courses: 2, assignments: 0, notifications: 1 } });
    expect(snap.courses).toHaveLength(2);
    expect(snap.assignments).toHaveLength(0);
    expect(snap.notifications).toHaveLength(1);
  });

  test('throws CanvasCliUnavailableError when canvas-cli is not installed (ENOENT)', async () => {
    const { runner } = makeRunner({
      courses: () => ({ ok: false, stdout: '', stderr: '', code: null, errno: 'ENOENT' }),
    });
    const source = new CanvasCliSource({ runner, bin: 'canvas-cli' });
    await expect(source.fetch()).rejects.toMatchObject({
      name: 'CanvasCliUnavailableError',
      code: 'not_installed',
    });
    await expect(source.fetch()).rejects.toThrow(/install canvas-cli/i);
  });

  test('throws CanvasCliUnavailableError on an auth error from canvas-cli', async () => {
    const { runner } = makeRunner({
      courses: () => ({
        ok: false,
        stdout: '',
        stderr:
          'canvas-cli: courses failed auth_required\n' +
          'canvas-cli: not logged in. Run `canvas-cli login` and complete SSO.',
        code: 2,
      }),
    });
    const source = new CanvasCliSource({ runner });
    let thrown: unknown;
    try {
      await source.fetch();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CanvasCliUnavailableError);
    expect((thrown as CanvasCliUnavailableError).code).toBe('auth_required');
    expect((thrown as Error).message).toMatch(/canvas-cli login/);
  });

  test('records a per-section error when items fails but courses succeeds (non-auth)', async () => {
    const { runner } = makeRunner({
      courses: () => ({ ok: true, stdout: COURSES_JSON, stderr: '', code: 0 }),
      items: () => ({ ok: false, stdout: '', stderr: 'network blip', code: 1 }),
    });
    const source = new CanvasCliSource({ runner });
    const snap = await source.fetch();
    expect(snap.sources_ok.courses).toBe(true);
    expect(snap.sources_ok.assignments).toBe(false);
    expect(snap.sources_ok.notifications).toBe(false);
    expect(snap.assignments).toEqual([]);
    expect(snap.errors?.assignments?.code).toBe('fetch_failed');
    expect(snap.errors?.notifications?.code).toBe('fetch_failed');
  });
});
