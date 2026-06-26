export { writeSnapshot } from './snapshot/writer.js';
export { parseSnapshot } from './snapshot/reader.js';
export { computeDiff, computeCanvasDiff } from './digest/diff.js';
export type {
  DiffEvent,
  DiffEventKind,
  DiffResourceType,
  DiffSource,
  DiffPriority,
} from './digest/diff.js';
export { composeDigest, kindEmoji, statusEmoji } from './digest/compose.js';
export type {
  Digest,
  DigestItem,
  DigestSection,
  DigestSourcesOk,
  DigestSourceKey,
  ComposeOptions,
} from './digest/compose.js';
export { formatTelegramDigest, TELEGRAM_MAX_CHARS } from './digest/format.js';
export {
  formatDiscordDigest,
  COLOR_ACTION,
  COLOR_WEEK,
  COLOR_CHANGED,
  COLOR_DISCOVERY,
} from './digest/format-discord.js';
export { sendTelegram } from './deliver/telegram.js';
export { sendDiscordMessages, FatalDiscordError } from './deliver/discord.js';
export type {
  DiscordEmbed,
  DiscordEmbedField,
  DiscordMessage,
  SendDiscordOptions,
} from './deliver/discord.js';
export type { CanvasDigestPayload, SnapshotMeta } from './snapshot/format.js';
export { SNAPSHOT_VERSION, SNAPSHOT_VERSION_LINE } from './snapshot/format.js';
export { CanvasApiSource } from './sources/canvas-api.js';
export type { CanvasApiSourceOptions } from './sources/canvas-api.js';
export {
  CanvasCliSource,
  CanvasCliUnavailableError,
  DEFAULT_CANVAS_CLI_BIN,
  DEFAULT_CANVAS_CLI_TIMEOUT_MS,
} from './sources/canvas-cli-source.js';
export type {
  CanvasCliSourceOptions,
  CanvasCliRunner,
  CanvasCliRunResult,
} from './sources/canvas-cli-source.js';
export {
  BrowserBridgeShellRunner,
  DEFAULT_PROFILE_NAME,
  DEFAULT_TIMEOUT_MS,
} from './sources/browser-bridge.js';
export type {
  BrowserBridgeRunner,
  BrowserBridgeResponse,
  BrowserBridgeError,
  BrowserBridgeInvokeArgs,
  BrowserBridgeShellRunnerOptions,
} from './sources/browser-bridge.js';
export { CanvasSource } from './sources/canvas-source.js';
export type {
  CanvasSnapshot,
  CanvasCourseEnvelope,
  CanvasAssignmentEnvelope,
  CanvasNotificationEnvelope,
  CanvasByCourseEnvelope,
  CanvasSourcesOk,
  CanvasSourceErrors,
  CanvasFetchOptions,
  CanvasSourceOptions,
} from './sources/canvas-source.js';
