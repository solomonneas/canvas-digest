// src/digest/format.ts
//
// Render a Digest as a Telegram-flavored HTML message with four sections:
// action_required, this_week, what_changed, discovery. HTML parse_mode
// accepts a narrow tag set (b, i, a, code, pre) and ampersand/lt/gt/quote
// must be escaped in any user-controlled text.
//
// Telegram caps single messages at ~4096 chars. When the rendered brief
// blows past that, we truncate sections in this order:
//   1. discovery
//   2. what_changed
//   3. this_week
// action_required is preserved intact - the whole point of that section is
// stuff the student must see today. A "(N more)" footer is added when truncated.

import type { Digest, DigestItem, DigestSection } from './compose.js';
import { kindEmoji, statusEmoji } from './compose.js';
import type { DiffEvent, DiffEventKind } from './diff.js';

export const TELEGRAM_MAX_CHARS = 4096;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'no date';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'no date';
  return new Date(iso).toLocaleDateString('en-CA');
}

function daysUntil(iso: string | null | undefined, fromIso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - new Date(fromIso).getTime()) / 86400000);
  if (days < 0) return ` (${Math.abs(days)}d overdue)`;
  if (days === 0) return ' (today)';
  if (days === 1) return ' (tomorrow)';
  return ` (in ${days}d)`;
}

function fmtSourcesOk(d: Digest): string {
  return `canvas=${d.sources_ok.canvas ? 'ok' : 'fail'}`;
}

function fmtItem(item: DigestItem, fromIso: string): string {
  const emoji = kindEmoji(item.category);
  const status = statusEmoji(item.canvas_submission_status);
  const when = item.due_at ? fmtDate(item.due_at) : '';
  const until = daysUntil(item.due_at, fromIso);
  const datePrefix = when ? `${when}${until} - ` : '';
  const title = item.url
    ? `<a href="${esc(item.url)}">${esc(item.title)}</a>`
    : `<b>${esc(item.title)}</b>`;
  // Multi-line summary indents continuation lines so the bullet stays clean.
  const summaryBlock = item.summary
    ? '\n' + item.summary.split('\n').map((line) => `    ${esc(line)}`).join('\n')
    : '';
  const statusBadge = status ? ` ${status}` : '';
  return `  ${emoji} ${datePrefix}${title}${statusBadge}${summaryBlock}`;
}

const DIFF_KIND_LABEL: Partial<Record<DiffEventKind, string>> = {
  NEW: 'NEW',
  GRADED: 'GRADED',
  DUE_DATE_CHANGED: 'DUE CHANGED',
  REMOVED: 'REMOVED',
};

function fmtDiffEvent(e: DiffEvent): string {
  const label = DIFF_KIND_LABEL[e.kind] ?? e.kind;
  const ctx = e.course_code ? ` (${esc(e.course_code)})` : '';
  const title = e.url ? `<a href="${esc(e.url)}">${esc(e.title)}</a>` : esc(e.title);
  if (e.kind === 'DUE_DATE_CHANGED') {
    return `  • ${label}: ${title}${ctx} ${fmtDate(e.from_due_at)} -> ${fmtDate(e.to_due_at)}`;
  }
  if (e.kind === 'NEW' && e.resource_type === 'notification') {
    const kind = e.notification_kind ? `[${esc(e.notification_kind)}] ` : '';
    return `  • ${label}: ${kind}${title}${ctx}`;
  }
  return `  • ${label}: ${title}${ctx}`;
}

interface RenderedSection {
  heading: string;
  lines: string[];
}

function renderItemSection(
  heading: string,
  section: DigestSection,
  fromIso: string,
): RenderedSection | null {
  if (section.count === 0) return null;
  return {
    heading,
    lines: section.items.map((i) => fmtItem(i, fromIso)),
  };
}

function renderChangesSection(events: DiffEvent[]): RenderedSection | null {
  if (events.length === 0) return null;
  const lines: string[] = [];
  for (const e of events) lines.push(fmtDiffEvent(e));
  return { heading: '🔥 <b>What changed</b>', lines };
}

function joinRendered(
  header: string[],
  sections: (RenderedSection | null)[],
  footer: string[],
): string {
  const parts: string[] = [...header];
  for (const s of sections) {
    if (!s) continue;
    parts.push('');
    parts.push(s.heading);
    parts.push(...s.lines);
  }
  if (footer.length > 0) {
    parts.push('');
    parts.push(...footer);
  }
  return parts.join('\n');
}

export function formatTelegramDigest(d: Digest, snapshotRelPath: string): string {
  const header: string[] = [
    `📚 <b>Canvas digest - ${esc(d.date)}</b>`,
    `<i>${d.diff_events.length} change${d.diff_events.length === 1 ? '' : 's'} since yesterday</i>`,
    `<i>sources: ${fmtSourcesOk(d)}</i>`,
  ];
  const footer: string[] = snapshotRelPath
    ? [`<i>Snapshot: ${esc(snapshotRelPath)}</i>`]
    : [];

  // Build each section as a structured value so the truncation pass can
  // shrink them in place without re-walking the digest.
  const action = renderItemSection('🚨 <b>Action required</b>', d.action_required, d.fetched_at);
  const week = renderItemSection('📅 <b>This week</b>', d.this_week, d.fetched_at);
  const changes = renderChangesSection(d.diff_events);
  const discovery = renderItemSection('🔭 <b>Discovery</b>', d.discovery, d.fetched_at);

  const fullSections: (RenderedSection | null)[] = [action, week, changes, discovery];
  let rendered = joinRendered(header, fullSections, footer);
  if (rendered.length <= TELEGRAM_MAX_CHARS) return rendered;

  // Truncation pass. Drop tail items from discovery first, then changes,
  // then this_week. action_required is never trimmed. After each shrink we
  // re-join and check the budget. The "(N more)" footer absorbs trimmed
  // counts so the reader knows something was dropped.
  const truncOrder: (RenderedSection | null)[] = [discovery, changes, week];
  for (const section of truncOrder) {
    if (!section) continue;
    let droppedCount = 0;
    while (rendered.length > TELEGRAM_MAX_CHARS && section.lines.length > 0) {
      // If a sentinel exists, remove it before dropping more (we'll re-add).
      const last = section.lines[section.lines.length - 1];
      if (last.includes('more dropped')) section.lines.pop();
      if (section.lines.length === 0) break;
      section.lines.pop();
      droppedCount += 1;
      // Re-add sentinel with the updated count.
      section.lines.push(`  • <i>(${droppedCount} more dropped)</i>`);
      rendered = joinRendered(header, fullSections, footer);
    }
    if (rendered.length <= TELEGRAM_MAX_CHARS) return rendered;
    // If the section is now sentinel-only or empty, collapse it so we don't
    // leave a heading with no content. Replace it in the section array with
    // null.
    const idx = fullSections.indexOf(section);
    if (idx >= 0 && (section.lines.length === 0 ||
        (section.lines.length === 1 && section.lines[0].includes('more dropped')))) {
      fullSections[idx] = null;
      rendered = joinRendered(header, fullSections, footer);
      if (rendered.length <= TELEGRAM_MAX_CHARS) return rendered;
    }
  }

  // Last-resort: even action_required overflows the cap. Trim its trailing
  // items one whole line at a time (HTML-safe) and add a "(N more dropped)"
  // sentinel inside the section. We never slice through a tag boundary.
  if (rendered.length > TELEGRAM_MAX_CHARS && action) {
    let droppedCount = 0;
    while (rendered.length > TELEGRAM_MAX_CHARS && action.lines.length > 0) {
      const last = action.lines[action.lines.length - 1];
      if (last.includes('more dropped')) action.lines.pop();
      if (action.lines.length === 0) break;
      action.lines.pop();
      droppedCount += 1;
      action.lines.push(`  • <i>(${droppedCount} more dropped)</i>`);
      rendered = joinRendered(header, fullSections, footer);
    }
  }
  return rendered;
}
