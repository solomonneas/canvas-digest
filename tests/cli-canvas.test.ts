import { describe, test, expect, vi, afterEach } from 'vitest';
import { canvasCommand } from '../src/cli.js';
import type { CanvasSnapshot, CanvasFetchOptions } from '../src/sources/canvas-source.js';

// A fake CanvasFetcher that records fetch options and returns a fixed snapshot.
function makeFetcher(snapshot: CanvasSnapshot): {
  source: { fetch(opts: CanvasFetchOptions): Promise<CanvasSnapshot> };
  calls: CanvasFetchOptions[];
} {
  const calls: CanvasFetchOptions[] = [];
  return {
    source: {
      async fetch(opts: CanvasFetchOptions): Promise<CanvasSnapshot> {
        calls.push(opts);
        return snapshot;
      },
    },
    calls,
  };
}

function snapshot(partial: Partial<CanvasSnapshot> = {}): CanvasSnapshot {
  return {
    fetched_at: '2026-05-16T11:00:00Z',
    courses: [],
    assignments: [],
    notifications: [],
    by_course: [],
    sources_ok: { courses: true, assignments: true, notifications: true },
    ...partial,
  };
}

function captureConsole(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    stdout.push(String(msg));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
    stderr.push(String(msg));
  });
  return {
    stdout,
    stderr,
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canvasCommand', () => {
  test('lists Canvas courses with the requested limit', async () => {
    const { source, calls } = makeFetcher(
      snapshot({
        courses: [
          {
            course_id: '1',
            code: 'EEL6787',
            name: 'Data Networks, Systems and Security',
            term: 'Summer 2026',
            role: 'student',
            url: 'https://your-school.instructure.com/courses/1',
          },
        ],
      }),
    );
    const consoleCapture = captureConsole();

    const code = await canvasCommand(['courses', 'list', '--limit', '3'], source);

    expect(code).toBe(0);
    expect(calls[0]?.limits).toEqual({ courses: 3, assignments: 3, notifications: 3 });
    expect(consoleCapture.stdout.join('\n')).toContain(
      'EEL6787 (Summer 2026) [student] - Data Networks, Systems and Security',
    );
    consoleCapture.restore();
  });

  test('lists assignments as JSON with lookahead and limit', async () => {
    const { source, calls } = makeFetcher(
      snapshot({
        assignments: [
          {
            assignment_id: 'a1',
            course_id: '1',
            course_code: 'ISM6577',
            kind: 'assignment',
            title: 'BCP Case Study',
            due_at: '2026-06-30T03:55:00Z',
            due_at_local: 'Jun 29, 2026, 11:55 PM',
            points_possible: 100,
            submission_status: 'not_submitted',
            url: 'https://your-school.instructure.com/a1',
          },
        ],
      }),
    );
    const consoleCapture = captureConsole();

    const code = await canvasCommand(
      ['assignments', 'list', '--json', '--lookahead', '21', '--limit', '5'],
      source,
    );

    expect(code).toBe(0);
    expect(calls[0]?.lookahead_days).toBe(21);
    expect(calls[0]?.limits).toEqual({ courses: 5, assignments: 5, notifications: 5 });
    const parsed = JSON.parse(consoleCapture.stdout.join('\n')) as Array<{ title: string }>;
    expect(parsed[0]?.title).toBe('BCP Case Study');
    consoleCapture.restore();
  });

  test('items list combines assignments and notifications only', async () => {
    const { source } = makeFetcher(
      snapshot({
        assignments: [
          {
            assignment_id: 'a1',
            course_id: '1',
            course_code: 'EEL6787',
            kind: 'assignment',
            title: 'Module Quiz',
            due_at: '2026-06-25T03:55:00Z',
            due_at_local: 'Jun 24, 2026, 11:55 PM',
            points_possible: 20,
            submission_status: 'submitted',
            url: '',
          },
        ],
        notifications: [
          {
            notification_id: 'n1',
            course_id: '1',
            course_code: 'EEL6787',
            course_name: 'Data Networks',
            kind: 'announcement',
            title: 'Office hours moved',
            summary: 'Tonight only.',
            url: '',
            posted_at: '2026-06-24T12:00:00Z',
            labels: [],
          },
        ],
      }),
    );
    const consoleCapture = captureConsole();

    const code = await canvasCommand(['items', 'list', '--limit', '2'], source);

    expect(code).toBe(0);
    expect(consoleCapture.stdout.join('\n')).toContain('Module Quiz');
    expect(consoleCapture.stdout.join('\n')).toContain('Office hours moved');
    consoleCapture.restore();
  });

  test('returns partial when the source reports a section failure', async () => {
    const { source } = makeFetcher(
      snapshot({
        sources_ok: { courses: true, assignments: true, notifications: false },
        errors: { notifications: { code: 'fetch_failed', message: 'announcements 403' } },
      }),
    );
    const consoleCapture = captureConsole();

    const code = await canvasCommand(['notifications', 'list'], source);

    expect(code).toBe(2);
    expect(consoleCapture.stderr.join('\n')).toContain(
      'canvas-digest canvas: notifications failed fetch_failed: announcements 403',
    );
    consoleCapture.restore();
  });

  test('rejects unknown canvas sections with usage status', async () => {
    const { source } = makeFetcher(snapshot());
    const consoleCapture = captureConsole();

    const code = await canvasCommand(['grades', 'list'], source);

    expect(code).toBe(64);
    expect(consoleCapture.stderr.join('\n')).toContain('canvas-digest canvas: unknown section grades');
    consoleCapture.restore();
  });
});
