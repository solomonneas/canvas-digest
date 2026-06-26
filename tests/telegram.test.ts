import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { composeDigest } from '../src/digest/compose.js';
import { formatTelegramDigest, TELEGRAM_MAX_CHARS } from '../src/digest/format.js';
import { sendTelegram } from '../src/deliver/telegram.js';
import type { CanvasDigestPayload } from '../src/snapshot/format.js';

const day1 = JSON.parse(readFileSync('tests/fixtures/canvas-day-1.json', 'utf-8')) as CanvasDigestPayload;
const day2 = JSON.parse(readFileSync('tests/fixtures/canvas-day-2.json', 'utf-8')) as CanvasDigestPayload;

const NOW = new Date('2026-05-16T11:00:00Z');

// Build a Canvas-only payload with N urgent assignments to force overflow.
function payloadWithManyUrgent(count: number, titlePrefix: string): CanvasDigestPayload {
  const assignments = [];
  for (let i = 0; i < count; i += 1) {
    assignments.push({
      assignment_id: `A${i}`,
      course_id: 'C1',
      course_code: 'X 1',
      course_name: 'Course X',
      kind: 'assignment',
      title: `${titlePrefix} ${i} - some long descriptive text to inflate the message`.repeat(2),
      due_at: '2026-05-17T00:00:00Z', // 1 day out -> action_required
      due_at_local: '',
      points_possible: 10,
      submission_status: 'not_submitted',
      url: `https://your-school.instructure.com/courses/1/assignments/${i}`,
    });
  }
  return {
    fetched_at: '2026-05-16T11:00:00Z',
    canvas: {
      fetched_at: '2026-05-16T11:00:00Z',
      courses: [],
      assignments,
      notifications: [],
      by_course: [],
      sources_ok: { courses: true, assignments: true, notifications: true },
    },
  };
}

describe('formatTelegramDigest', () => {
  test('renders header with date and source status', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html).toContain('📚 <b>Canvas digest - 2026-05-16</b>');
    expect(html).toContain('sources: canvas=ok');
  });

  test('renders snapshot footer', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html).toContain('<i>Snapshot: 2026-05-16.md</i>');
  });

  test('omits the snapshot footer when no path is provided', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '');
    expect(html).not.toContain('Snapshot:');
  });

  test('omits sections that are empty', () => {
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
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html).not.toContain('🚨');
    expect(html).not.toContain('📅');
    expect(html).not.toContain('🔥');
    expect(html).not.toContain('🔭');
  });

  test('renders Action required section for urgent assignments', () => {
    const d = composeDigest(payloadWithManyUrgent(1, 'Final project'), null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html).toContain('🚨 <b>Action required</b>');
    expect(html).toContain('Final project');
  });

  test('renders This week section with Canvas assignments', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html).toContain('📅 <b>This week</b>');
    expect(html).toContain('Module 1 Discussion Post');
  });

  test('renders What changed section', () => {
    const d = composeDigest(day2, day1, '2026-05-17', {
      now: new Date('2026-05-17T11:00:00Z'),
    });
    const html = formatTelegramDigest(d, '2026-05-17.md');
    expect(html).toContain('🔥 <b>What changed</b>');
    expect(html).toContain('NEW:');
    expect(html).toContain('Module 1 Lab Report');
    expect(html).toContain('DUE CHANGED:');
  });

  test('escapes HTML-special characters in titles', () => {
    const evil: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [
          { course_id: 'C1', code: 'X 1', name: 'A & B <C>', term: null, url: '' },
        ],
        assignments: [
          {
            assignment_id: 'A1',
            course_id: 'C1',
            course_code: 'X 1',
            kind: 'online_upload',
            title: '<script>x</script>',
            due_at: '2026-05-19T00:00:00Z', // 3 days out -> this_week
            due_at_local: '',
            points_possible: 1,
            submission_status: 'not_submitted',
            url: '',
          },
        ],
        notifications: [],
        by_course: [],
        sources_ok: { courses: true, assignments: true, notifications: true },
      },
    };
    const d = composeDigest(evil, null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('renders within Telegram char budget for normal-sized digest', () => {
    const d = composeDigest(day2, day1, '2026-05-17', {
      now: new Date('2026-05-17T11:00:00Z'),
    });
    const html = formatTelegramDigest(d, '2026-05-17.md');
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  test('truncates this_week first when over 4096 chars', () => {
    // Many assignments due ~5 days out -> this_week, big enough to overflow.
    const assignments = [];
    for (let i = 0; i < 200; i += 1) {
      assignments.push({
        assignment_id: `A${i}`,
        course_id: 'C1',
        course_code: 'X 1',
        course_name: 'Course X',
        kind: 'assignment',
        title: `Assignment ${i} with a fairly long descriptive title that adds chars`,
        due_at: '2026-05-20T00:00:00Z',
        due_at_local: '',
        points_possible: 10,
        submission_status: 'not_submitted',
        url: `https://your-school.instructure.com/courses/1/assignments/${i}`,
      });
    }
    const payload: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [],
        assignments,
        notifications: [],
        by_course: [],
        sources_ok: { courses: true, assignments: true, notifications: true },
      },
    };
    const d = composeDigest(payload, null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(html).toMatch(/more dropped/);
  });

  test('last-resort truncation trims action_required line-at-a-time without slicing HTML', () => {
    const d = composeDigest(payloadWithManyUrgent(300, 'Hold'), null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    // HTML safety: no broken tag pairs.
    const open = (html.match(/<(b|i|a)\b[^>]*>/g) ?? []).length;
    const close = (html.match(/<\/(b|i|a)>/g) ?? []).length;
    expect(open).toBe(close);
    expect(html).toMatch(/more dropped/);
  });

  test('preserves Action required even with oversized brief', () => {
    // One critical urgent assignment plus a huge this_week list.
    const assignments = [
      {
        assignment_id: 'CRIT',
        course_id: 'C1',
        course_code: 'X 1',
        course_name: 'Course X',
        kind: 'assignment',
        title: 'CRITICAL assignment',
        due_at: '2026-05-17T00:00:00Z', // action_required
        due_at_local: '',
        points_possible: 100,
        submission_status: 'not_submitted',
        url: '',
      },
    ];
    for (let i = 0; i < 200; i += 1) {
      assignments.push({
        assignment_id: `A${i}`,
        course_id: 'C1',
        course_code: 'X 1',
        course_name: 'Course X',
        kind: 'assignment',
        title: `Assignment ${i} with a fairly long descriptive title that adds chars`,
        due_at: '2026-05-20T00:00:00Z', // this_week
        due_at_local: '',
        points_possible: 10,
        submission_status: 'not_submitted',
        url: `https://your-school.instructure.com/courses/1/assignments/${i}`,
      });
    }
    const payload: CanvasDigestPayload = {
      fetched_at: '2026-05-16T11:00:00Z',
      canvas: {
        fetched_at: '2026-05-16T11:00:00Z',
        courses: [],
        assignments,
        notifications: [],
        by_course: [],
        sources_ok: { courses: true, assignments: true, notifications: true },
      },
    };
    const d = composeDigest(payload, null, '2026-05-16', { now: NOW });
    const html = formatTelegramDigest(d, '2026-05-16.md');
    expect(html.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(html).toContain('CRITICAL assignment');
    expect(html).toContain('🚨 <b>Action required</b>');
  });
});

describe('sendTelegram', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('posts to Bot API with HTML parse_mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    );

    await sendTelegram({
      botToken: 'XXX',
      chatId: '12345',
      html: '<b>hi</b>',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telegram.org/botXXX/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({
      chat_id: '12345',
      text: '<b>hi</b>',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  test('throws on non-200 Telegram response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'bad token' }), { status: 401 }),
    );
    await expect(sendTelegram({ botToken: 'X', chatId: '1', html: 'x' })).rejects.toThrow(/bad token/);
  });
});
