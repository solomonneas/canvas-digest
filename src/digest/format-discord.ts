// src/digest/format-discord.ts
//
// Render a Digest as a Discord message stream. Output is a DiscordMessage[]
// that the deliverer batches into webhook POSTs (max 10 embeds per message).
//
// Layout:
//   1. Plain-text header message (no embeds): date + section tallies +
//      source-OK summary.
//   2. One embed per DigestItem, grouped by section. Section color codes:
//        action_required -> red    (0xDC2626)
//        this_week       -> amber  (0xD97706)
//        what_changed    -> blue   (0x2563EB)
//        discovery       -> gray   (0x6B7280)
//
// Per-embed description cap is 4096 chars; we keep entries small enough that
// the cap never trips in practice. Long summaries are truncated to 400 chars.

import type { Digest, DigestItem } from './compose.js';
import { kindEmoji, statusEmoji } from './compose.js';
import type { DiscordEmbed, DiscordMessage } from '../deliver/discord.js';
import type { DiffEvent } from './diff.js';

const COLOR_ACTION = 0xdc2626;
const COLOR_WEEK = 0xd97706;
const COLOR_CHANGED = 0x2563eb;
const COLOR_DISCOVERY = 0x6b7280;

const SECTION_LABEL = {
  action_required: 'Action required',
  this_week: 'This week',
  what_changed: 'What changed',
  discovery: 'Discovery',
} as const;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(iso).toLocaleDateString('en-CA');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function sourceOkSummary(d: Digest): string {
  return `canvas=${d.sources_ok.canvas ? 'ok' : 'fail'}`;
}

function makeHeaderMessage(d: Digest): DiscordMessage {
  const tallies = [
    `${d.action_required.count} in action`,
    `${d.this_week.count} this week`,
    `${d.what_changed.count} change${d.what_changed.count === 1 ? '' : 's'}`,
    `${d.discovery.count} discovery`,
  ].join(' / ');
  const lines = [
    `**Canvas digest - ${d.date}**`,
    tallies,
    `sources: ${sourceOkSummary(d)}`,
  ];
  return { content: lines.join('\n') };
}

function itemToEmbed(item: DigestItem, color: number): DiscordEmbed {
  const emoji = kindEmoji(item.category);
  const status = statusEmoji(item.canvas_submission_status);
  const fields: DiscordEmbed['fields'] = [];
  const due = fmtDate(item.due_at);
  if (due) fields.push({ name: 'When', value: due, inline: true });
  if (item.category) {
    fields.push({ name: 'Type', value: `${emoji} ${item.category}`, inline: true });
  }
  if (item.canvas_submission_status) {
    fields.push({
      name: 'Status',
      value: `${status} ${item.canvas_submission_status.replace(/_/g, ' ')}`.trim(),
      inline: true,
    });
  }
  // Prefix the visible title with the kind emoji so the embed catches the eye
  // at a glance. The composer keeps `title` plain so tests stay deterministic.
  const titlePrefix = emoji ? `${emoji} ` : '';
  const embed: DiscordEmbed = {
    title: truncate(`${titlePrefix}${item.title}`, 250),
    color,
    footer: { text: 'Canvas' },
  };
  if (item.url) embed.url = item.url;
  if (item.summary) embed.description = truncate(item.summary, 400);
  if (fields.length > 0) embed.fields = fields;
  return embed;
}

function diffEventToEmbed(e: DiffEvent, color: number): DiscordEmbed {
  const fields: DiscordEmbed['fields'] = [];
  if (e.course_code) fields.push({ name: 'Course', value: e.course_code, inline: true });
  if (e.from_due_at || e.to_due_at) {
    fields.push({
      name: 'Date change',
      value: `${fmtDate(e.from_due_at) || '?'} -> ${fmtDate(e.to_due_at) || '?'}`,
      inline: true,
    });
  }
  const embed: DiscordEmbed = {
    title: truncate(`[${e.kind}] ${e.title}`, 250),
    color,
    footer: { text: 'Canvas' },
  };
  if (e.url) embed.url = e.url;
  if (fields.length > 0) embed.fields = fields;
  return embed;
}

function sectionMessages(
  heading: string,
  items: DigestItem[],
  color: number,
): DiscordMessage[] {
  if (items.length === 0) return [];
  // Header content goes on the first message of the section.
  const embeds = items.map((i) => itemToEmbed(i, color));
  return [{ content: `**${heading}**`, embeds }];
}

function changesMessages(events: DiffEvent[]): DiscordMessage[] {
  if (events.length === 0) return [];
  const embeds = events.map((e) => diffEventToEmbed(e, COLOR_CHANGED));
  return [{ content: `**${SECTION_LABEL.what_changed}**`, embeds }];
}

export function formatDiscordDigest(d: Digest): DiscordMessage[] {
  const out: DiscordMessage[] = [];
  out.push(makeHeaderMessage(d));
  out.push(...sectionMessages(SECTION_LABEL.action_required, d.action_required.items, COLOR_ACTION));
  out.push(...sectionMessages(SECTION_LABEL.this_week, d.this_week.items, COLOR_WEEK));
  out.push(...changesMessages(d.diff_events));
  out.push(...sectionMessages(SECTION_LABEL.discovery, d.discovery.items, COLOR_DISCOVERY));
  return out;
}

export {
  COLOR_ACTION,
  COLOR_WEEK,
  COLOR_CHANGED,
  COLOR_DISCOVERY,
};
