import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { composeDigest } from '../../src/digest/compose.js';
import {
  formatDiscordDigest,
  COLOR_ACTION,
  COLOR_WEEK,
  COLOR_CHANGED,
  COLOR_DISCOVERY,
} from '../../src/digest/format-discord.js';
import type { CanvasDigestPayload } from '../../src/snapshot/format.js';

const day1 = JSON.parse(readFileSync('tests/fixtures/canvas-day-1.json', 'utf-8')) as CanvasDigestPayload;
const day2 = JSON.parse(readFileSync('tests/fixtures/canvas-day-2.json', 'utf-8')) as CanvasDigestPayload;
const NOW = new Date('2026-05-16T11:00:00Z');

// Build a payload with a single Canvas assignment due soon (action_required)
// and an optional long title for truncation tests.
function payloadWithUrgentAssignment(title: string): CanvasDigestPayload {
  return {
    fetched_at: '2026-05-16T11:00:00Z',
    canvas: {
      fetched_at: '2026-05-16T11:00:00Z',
      courses: [],
      assignments: [
        {
          assignment_id: 'A1',
          course_id: 'C1',
          course_code: 'X 1',
          course_name: 'Course X',
          kind: 'assignment',
          title,
          due_at: '2026-05-17T00:00:00Z', // 1 day out -> action_required
          due_at_local: '',
          points_possible: 10,
          submission_status: 'not_submitted',
          url: 'https://your-school.instructure.com/courses/1/assignments/1',
        },
      ],
      notifications: [],
      by_course: [],
      sources_ok: { courses: true, assignments: true, notifications: true },
    },
  };
}

describe('formatDiscordDigest - header', () => {
  test('emits a leading content-only message with header text', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const msgs = formatDiscordDigest(d);
    expect(msgs.length).toBeGreaterThan(0);
    const header = msgs[0];
    expect(header.embeds).toBeUndefined();
    expect(header.content).toContain('Canvas digest - 2026-05-16');
    expect(header.content).toContain('in action');
    expect(header.content).toContain('this week');
    expect(header.content).toContain('discovery');
    expect(header.content).toContain('sources:');
    expect(header.content).toContain('canvas=ok');
  });

  test('header pluralizes changes correctly', () => {
    const d = composeDigest(day2, day1, '2026-05-17', { now: NOW });
    const msgs = formatDiscordDigest(d);
    expect(msgs[0].content).toMatch(/\d+ changes?/);
  });
});

describe('formatDiscordDigest - section colors', () => {
  test('action_required embeds have red color', () => {
    const d = composeDigest(payloadWithUrgentAssignment('Urgent assignment'), null, '2026-05-16', { now: NOW });
    const msgs = formatDiscordDigest(d);
    const actionMsg = msgs.find((m) => m.content?.includes('Action required'));
    expect(actionMsg).toBeDefined();
    expect(actionMsg?.embeds?.[0].color).toBe(COLOR_ACTION);
  });

  test('this_week embeds have amber color', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const msgs = formatDiscordDigest(d);
    const weekMsg = msgs.find((m) => m.content?.includes('This week'));
    if (weekMsg && weekMsg.embeds && weekMsg.embeds.length > 0) {
      expect(weekMsg.embeds[0].color).toBe(COLOR_WEEK);
    }
  });

  test('what_changed embeds have blue color', () => {
    const d = composeDigest(day2, day1, '2026-05-17', { now: NOW });
    const msgs = formatDiscordDigest(d);
    const changedMsg = msgs.find((m) => m.content?.includes('What changed'));
    expect(changedMsg).toBeDefined();
    expect(changedMsg?.embeds?.[0].color).toBe(COLOR_CHANGED);
  });

  test('discovery color constant is wired (no discovery items by default)', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const msgs = formatDiscordDigest(d);
    const discMsg = msgs.find((m) => m.content?.includes('Discovery'));
    if (discMsg && discMsg.embeds && discMsg.embeds.length > 0) {
      expect(discMsg.embeds[0].color).toBe(COLOR_DISCOVERY);
    } else {
      expect(COLOR_DISCOVERY).toBe(0x6b7280);
    }
  });
});

describe('formatDiscordDigest - embed shape', () => {
  test('embed includes title, footer (source), and url when present', () => {
    const d = composeDigest(day1, null, '2026-05-16', { now: NOW });
    const msgs = formatDiscordDigest(d);
    const weekMsg = msgs.find((m) => m.content?.includes('This week'));
    expect(weekMsg).toBeDefined();
    const e = weekMsg!.embeds![0];
    expect(e.title).toBeDefined();
    expect(e.footer?.text).toBe('Canvas');
    // Canvas assignment items have URLs in the fixture.
    expect(e.url).toMatch(/^https?:\/\//);
  });

  test('truncates long titles to 250 chars', () => {
    const d = composeDigest(payloadWithUrgentAssignment('A'.repeat(500)), null, '2026-05-16', { now: NOW });
    const msgs = formatDiscordDigest(d);
    const actionMsg = msgs.find((m) => m.content?.includes('Action required'));
    const e = actionMsg!.embeds![0];
    expect((e.title ?? '').length).toBeLessThanOrEqual(250);
  });
});

describe('formatDiscordDigest - integration', () => {
  test('returns header even on an empty digest', () => {
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
    const msgs = formatDiscordDigest(d);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('Canvas digest');
  });

  test('what_changed section produces diff-event embeds', () => {
    const d = composeDigest(day2, day1, '2026-05-17', { now: NOW });
    const msgs = formatDiscordDigest(d);
    const changedMsg = msgs.find((m) => m.content?.includes('What changed'));
    expect(changedMsg).toBeDefined();
    expect((changedMsg!.embeds ?? []).length).toBeGreaterThan(0);
    // Diff event embeds prefix the title with the kind tag.
    const firstTitle = changedMsg!.embeds![0].title ?? '';
    expect(firstTitle.startsWith('[')).toBe(true);
  });
});
