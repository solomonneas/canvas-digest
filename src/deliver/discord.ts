// src/deliver/discord.ts
//
// Discord webhook deliverer. Posts a DigestMessage[] sequentially to a webhook
// URL, batching embeds 10 per message (Discord's per-message ceiling) and
// pausing ~200ms between messages to avoid the webhook rate limiter.
//
// Constraints (from the Discord API docs):
//   - max 10 embeds per webhook POST
//   - per-embed description: 4096 chars
//   - per-embed total chars across title/description/fields/footer/author:
//     6000 (we render conservatively under this)
//   - content (top-level message string): 2000 chars
//   - webhook bucket: 5 req / 2s typical, but a 429 from Discord includes a
//     retry_after we must respect.
//
// Errors:
//   - 5xx and 429: retried up to 3 times with backoff (linear 500/1000ms,
//     or the server's retry_after if present).
//   - 4xx other than 429: throws after first attempt.
//   - non-fetch errors (network): retried like 5xx.

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  author?: { name: string; url?: string };
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface SendDiscordOptions {
  webhookUrl: string;
  messages: DiscordMessage[];
  // Test-time fetch override. Defaults to globalThis.fetch.
  fetchImpl?: typeof globalThis.fetch;
  // Override the inter-message delay. Defaults to 200ms; tests pass 0.
  interMessageDelayMs?: number;
  // Override the retry sleep helper for deterministic testing.
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_DELAY_MS = 200;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_RETRIES = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Split a DigestMessage with >10 embeds into multiple messages preserving
// the leading `content`. The first chunk keeps `content`; subsequent chunks
// carry embeds only.
function chunkMessages(messages: DiscordMessage[]): DiscordMessage[] {
  const out: DiscordMessage[] = [];
  for (const msg of messages) {
    const embeds = msg.embeds ?? [];
    if (embeds.length <= MAX_EMBEDS_PER_MESSAGE) {
      out.push(msg);
      continue;
    }
    for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
      const slice = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
      if (i === 0) {
        out.push({ content: msg.content, embeds: slice });
      } else {
        out.push({ embeds: slice });
      }
    }
  }
  return out;
}

async function postOnce(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  msg: DiscordMessage,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  });
}

// Exported so callers can `error instanceof FatalDiscordError` to distinguish
// non-retryable 4xx failures (bad webhook URL, malformed payload) from
// transient 5xx / network errors that already burned through the retry budget.
export class FatalDiscordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalDiscordError';
  }
}

async function postWithRetry(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  msg: DiscordMessage,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < MAX_RETRIES) {
    attempt += 1;
    try {
      const res = await postOnce(fetchImpl, url, msg);
      if (res.ok) return;
      const status = res.status;
      if (status === 429 || status >= 500) {
        // Honor retry_after from JSON body when present; otherwise linear
        // backoff. Discord returns retry_after in seconds (float).
        let backoffMs = attempt * 500;
        try {
          const body = (await res.json()) as { retry_after?: number };
          if (body && typeof body.retry_after === 'number') {
            backoffMs = Math.ceil(body.retry_after * 1000);
          }
        } catch {
          // ignore
        }
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Discord ${status} after ${attempt} attempts`);
        }
        await sleepFn(backoffMs);
        continue;
      }
      // 4xx (other than 429): non-retryable. Use FatalDiscordError so the
      // outer catch doesn't loop.
      const body = await res.text().catch(() => '');
      throw new FatalDiscordError(`Discord ${status}: ${body}`);
    } catch (e) {
      if (e instanceof FatalDiscordError) throw e;
      lastErr = e;
      if (attempt >= MAX_RETRIES) break;
      // Network errors: linear backoff and retry.
      await sleepFn(attempt * 500);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Discord send failed');
}

export async function sendDiscordMessages(opts: SendDiscordOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const delay = opts.interMessageDelayMs ?? DEFAULT_DELAY_MS;
  const messages = chunkMessages(opts.messages);
  for (let i = 0; i < messages.length; i += 1) {
    if (i > 0 && delay > 0) await sleepFn(delay);
    await postWithRetry(fetchImpl, opts.webhookUrl, messages[i], sleepFn);
  }
}
