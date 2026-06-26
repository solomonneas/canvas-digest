import { describe, test, expect } from 'vitest';
import { CanvasSource } from '../../src/sources/canvas-source.js';
import type {
  BrowserBridgeInvokeArgs,
  BrowserBridgeResponse,
  BrowserBridgeRunner,
} from '../../src/sources/browser-bridge.js';

function makeRunner(
  byAction: Record<string, BrowserBridgeResponse<unknown> | (() => BrowserBridgeResponse<unknown>) | (() => Promise<BrowserBridgeResponse<unknown>>)>,
): { runner: BrowserBridgeRunner; calls: BrowserBridgeInvokeArgs[] } {
  const calls: BrowserBridgeInvokeArgs[] = [];
  const runner: BrowserBridgeRunner = {
    async invoke<T = unknown>(args: BrowserBridgeInvokeArgs): Promise<BrowserBridgeResponse<T>> {
      calls.push(args);
      const handler = byAction[args.action];
      if (handler === undefined) {
        return { ok: false, error: { code: 'no_mock', message: `no mock for ${args.action}` } } as BrowserBridgeResponse<T>;
      }
      const value = typeof handler === 'function' ? await (handler as () => BrowserBridgeResponse<T>)() : (handler as BrowserBridgeResponse<T>);
      return value;
    },
  };
  return { runner, calls };
}

describe('CanvasSource.fetch', () => {
  test('assembles snapshot when all three actions succeed', async () => {
    const { runner, calls } = makeRunner({
      'list-courses': {
        ok: true,
        result: {
          courses: [
            { course_id: '1', code: 'ISM6577', name: 'A', term: null, url: 'u' },
            { course_id: '2', code: 'EEL6787', name: 'B', term: null, url: 'u' },
          ],
        },
      },
      'list-upcoming-assignments': {
        ok: true,
        result: {
          assignments: [
            {
              assignment_id: 'a_1',
              course_id: '1',
              course_code: 'ISM6577',
              kind: 'assignment',
              title: 'T',
              due_at: '2026-05-20T23:59:00Z',
              due_at_local: 'Tue May 20, 11:59 PM ET',
              points_possible: 10,
              submission_status: 'not_submitted',
              url: 'u',
            },
          ],
          by_course: [{ course_id: '1', course_code: 'ISM6577', course_name: 'A', count: 1 }],
        },
      },
      'list-recent-notifications': {
        ok: true,
        result: {
          notifications: [
            {
              notification_id: 'n_1',
              course_id: '1',
              course_code: 'ISM6577',
              course_name: 'A',
              kind: 'announcement',
              title: 'Welcome',
              summary: '',
              url: 'u',
              posted_at: '2026-05-16T13:00:00Z',
              labels: ['unread'],
            },
          ],
        },
      },
    });

    const source = new CanvasSource({ runner });
    const snap = await source.fetch({ lookahead_days: 14, limits: { notifications: 25 } });

    expect(snap.sources_ok).toEqual({ courses: true, assignments: true, notifications: true });
    expect(snap.courses).toHaveLength(2);
    expect(snap.assignments).toHaveLength(1);
    expect(snap.notifications).toHaveLength(1);
    expect(snap.by_course).toHaveLength(1);
    expect(snap.errors).toBeUndefined();
    expect(snap.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Verify call shape
    expect(calls).toHaveLength(3);
    const assignArgs = calls.find((c) => c.action === 'list-upcoming-assignments');
    expect(assignArgs?.input).toEqual({ lookahead_days: 14 });
    const notifArgs = calls.find((c) => c.action === 'list-recent-notifications');
    expect(notifArgs?.input).toEqual({ limit: 25 });
  });

  test('returns partial snapshot when one action fails (Promise.allSettled behavior)', async () => {
    const { runner } = makeRunner({
      'list-courses': {
        ok: true,
        result: { courses: [{ course_id: '1', code: 'X', name: 'Y', term: null, url: 'u' }] },
      },
      'list-upcoming-assignments': {
        ok: false,
        error: { code: 'selector_drift', message: 'no assignments tile' },
      },
      'list-recent-notifications': () => {
        throw new Error('runner exploded');
      },
    });

    const source = new CanvasSource({ runner });
    const snap = await source.fetch();

    expect(snap.sources_ok).toEqual({ courses: true, assignments: false, notifications: false });
    expect(snap.courses).toHaveLength(1);
    expect(snap.assignments).toEqual([]);
    expect(snap.notifications).toEqual([]);
    expect(snap.errors?.assignments?.code).toBe('selector_drift');
    expect(snap.errors?.notifications?.code).toBe('rejected');
  });

  test('uses provided profileName when invoking the runner', async () => {
    const { runner, calls } = makeRunner({
      'list-courses': { ok: true, result: { courses: [] } },
      'list-upcoming-assignments': { ok: true, result: { assignments: [], by_course: [] } },
      'list-recent-notifications': { ok: true, result: { notifications: [] } },
    });

    const source = new CanvasSource({ runner, profileName: 'custom' });
    await source.fetch();
    for (const c of calls) expect(c.profileName).toBe('custom');
  });

  test('defaults to canvas-digest profile when not provided', async () => {
    const { runner, calls } = makeRunner({
      'list-courses': { ok: true, result: { courses: [] } },
      'list-upcoming-assignments': { ok: true, result: { assignments: [], by_course: [] } },
      'list-recent-notifications': { ok: true, result: { notifications: [] } },
    });

    const source = new CanvasSource({ runner });
    await source.fetch();
    for (const c of calls) expect(c.profileName).toBe('canvas-digest');
  });

  test('tolerates non-array result fields by returning empty arrays', async () => {
    const { runner } = makeRunner({
      'list-courses': { ok: true, result: { courses: null } },
      'list-upcoming-assignments': { ok: true, result: { assignments: 'oops', by_course: undefined } },
      'list-recent-notifications': { ok: true, result: {} },
    });

    const source = new CanvasSource({ runner });
    const snap = await source.fetch();
    expect(snap.courses).toEqual([]);
    expect(snap.assignments).toEqual([]);
    expect(snap.notifications).toEqual([]);
    expect(snap.by_course).toEqual([]);
    expect(snap.sources_ok).toEqual({ courses: true, assignments: true, notifications: true });
  });

  test('propagates since as ISO string for notifications', async () => {
    const { runner, calls } = makeRunner({
      'list-courses': { ok: true, result: { courses: [] } },
      'list-upcoming-assignments': { ok: true, result: { assignments: [], by_course: [] } },
      'list-recent-notifications': { ok: true, result: { notifications: [] } },
    });
    const source = new CanvasSource({ runner });
    const since = new Date('2026-05-10T00:00:00Z');
    await source.fetch({ since });
    const notif = calls.find((c) => c.action === 'list-recent-notifications');
    expect(notif?.input).toEqual({ since: '2026-05-10T00:00:00.000Z' });
  });
});
