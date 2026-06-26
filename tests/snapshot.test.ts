// tests/snapshot.test.ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { writeSnapshot } from '../src/snapshot/writer.js';
import { parseSnapshot } from '../src/snapshot/reader.js';
import { SNAPSHOT_VERSION } from '../src/snapshot/format.js';
import type { CanvasDigestPayload } from '../src/snapshot/format.js';

const day1 = JSON.parse(readFileSync('tests/fixtures/canvas-day-1.json', 'utf-8')) as CanvasDigestPayload;

describe('snapshot writer/reader', () => {
  test('writes YAML frontmatter + version line + markdown body + JSON tail', () => {
    const md = writeSnapshot(day1, { date: '2026-05-16', generatedAt: '2026-05-16T11:00:00Z' });

    expect(md).toMatch(/^---\n/);
    expect(md).toContain('tags:\n  - canvas-snapshot');
    expect(md).toContain('date: 2026-05-16');
    expect(md).toContain('courses: 1');
    expect(md).toContain('assignments: 2');
    expect(md).toContain('notifications: 2');
    expect(md).toContain('<!-- canvas-digest-snapshot-version: 1 -->');
    expect(md).toContain('## EEL 6787 - Data Networks, Systems and Security');
    expect(md).toContain('Module 1 Discussion Post');
    expect(md).toContain('Syllabus Acknowledgment');
    expect(md).toContain('Welcome to EEL 6787');
    expect(md).toContain('Module 1 Intro Thread');
    expect(md).toContain('## Raw payload\n```json');
  });

  test('SNAPSHOT_VERSION constant is 1', () => {
    expect(SNAPSHOT_VERSION).toBe(1);
  });

  test('round-trips: snapshot can be parsed back to the same payload', () => {
    const md = writeSnapshot(day1, { date: '2026-05-16', generatedAt: '2026-05-16T11:00:00Z' });
    const parsed = parseSnapshot(md);
    expect(parsed).toEqual(day1);
  });

  test('tolerates an older version marker on the line (reader keys on JSON tail)', () => {
    const md = writeSnapshot(day1, {
      date: '2026-05-16',
      generatedAt: '2026-05-16T11:00:00Z',
    }).replace(
      '<!-- canvas-digest-snapshot-version: 1 -->',
      '<!-- canvas-digest-snapshot-version: 0 -->',
    );
    const parsed = parseSnapshot(md);
    expect(parsed).toEqual(day1);
  });
});

describe('parseSnapshot failure modes', () => {
  test('throws on missing JSON tail', () => {
    expect(() => parseSnapshot('no tail here')).toThrow(/no JSON tail/);
  });

  test('throws on unclosed JSON tail', () => {
    expect(() => parseSnapshot('## Raw payload\n```json\n{"x":1}')).toThrow(/not closed/);
  });

  test('throws on invalid JSON', () => {
    expect(() => parseSnapshot('## Raw payload\n```json\n{not json}\n```\n')).toThrow();
  });
});
