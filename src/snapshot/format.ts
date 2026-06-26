// src/snapshot/format.ts
//
// A snapshot wraps a single CanvasSnapshot. The markdown serializer in
// writer.ts stamps a SNAPSHOT_VERSION_LINE at the top so future readers can
// dispatch on shape. The reader keys only on the fenced JSON tail, so the
// version line is advisory.

import type { CanvasSnapshot } from '../sources/canvas-source.js';

export interface CanvasDigestPayload {
  fetched_at: string;
  canvas: CanvasSnapshot;
}

export interface SnapshotMeta {
  date: string;         // YYYY-MM-DD
  generatedAt: string;  // ISO 8601
}

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_VERSION_LINE = `<!-- canvas-digest-snapshot-version: ${SNAPSHOT_VERSION} -->`;

export const JSON_TAIL_OPEN = '## Raw payload\n```json\n';
export const JSON_TAIL_CLOSE = '\n```\n';
export const FRONTMATTER_DELIM = '---';
