import { describe, test, expect, vi } from 'vitest';
import {
  sendDiscordMessages,
  type DiscordMessage,
  type DiscordEmbed,
} from '../../src/deliver/discord.js';

function makeOkResponse(): Response {
  return new Response(null, { status: 204 });
}

function makeFetch(responses: Response[]): {
  fetchImpl: typeof globalThis.fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return res;
  };
  return { fetchImpl, calls };
}

function makeEmbeds(n: number): DiscordEmbed[] {
  return Array.from({ length: n }, (_, k) => ({
    title: `Embed ${k}`,
    color: 0xff0000,
  }));
}

describe('sendDiscordMessages', () => {
  test('posts a single message with content + embeds', async () => {
    const { fetchImpl, calls } = makeFetch([makeOkResponse()]);
    const msg: DiscordMessage = {
      content: 'hello',
      embeds: [{ title: 'X' }],
    };
    await sendDiscordMessages({
      webhookUrl: 'https://discord.test/hook',
      messages: [msg],
      fetchImpl,
      interMessageDelayMs: 0,
    });
    expect(calls.length).toBe(1);
    expect((calls[0].body as DiscordMessage).content).toBe('hello');
  });

  test('chunks >10 embeds across multiple messages', async () => {
    const { fetchImpl, calls } = makeFetch([
      makeOkResponse(),
      makeOkResponse(),
      makeOkResponse(),
    ]);
    const msg: DiscordMessage = { content: 'header', embeds: makeEmbeds(25) };
    await sendDiscordMessages({
      webhookUrl: 'https://discord.test/hook',
      messages: [msg],
      fetchImpl,
      interMessageDelayMs: 0,
    });
    expect(calls.length).toBe(3);
    expect((calls[0].body as DiscordMessage).embeds?.length).toBe(10);
    expect((calls[1].body as DiscordMessage).embeds?.length).toBe(10);
    expect((calls[2].body as DiscordMessage).embeds?.length).toBe(5);
    // Only first chunk carries the leading content.
    expect((calls[0].body as DiscordMessage).content).toBe('header');
    expect((calls[1].body as DiscordMessage).content).toBeUndefined();
  });

  test('exact 10-embed boundary stays as one message', async () => {
    const { fetchImpl, calls } = makeFetch([makeOkResponse()]);
    const msg: DiscordMessage = { embeds: makeEmbeds(10) };
    await sendDiscordMessages({
      webhookUrl: 'https://discord.test/hook',
      messages: [msg],
      fetchImpl,
      interMessageDelayMs: 0,
    });
    expect(calls.length).toBe(1);
  });

  test('retries on 429 with server retry_after', async () => {
    const retryAfterBody = JSON.stringify({ retry_after: 0.05 });
    const responses = [
      new Response(retryAfterBody, { status: 429, headers: { 'content-type': 'application/json' } }),
      makeOkResponse(),
    ];
    const { fetchImpl, calls } = makeFetch(responses);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await sendDiscordMessages({
      webhookUrl: 'https://discord.test/hook',
      messages: [{ content: 'x' }],
      fetchImpl,
      interMessageDelayMs: 0,
      sleepFn,
    });
    expect(calls.length).toBe(2);
    expect(sleepFn).toHaveBeenCalled();
    const firstSleep = sleepFn.mock.calls[0][0];
    expect(firstSleep).toBeGreaterThanOrEqual(50);
  });

  test('retries on 5xx with linear backoff', async () => {
    const responses = [
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
      makeOkResponse(),
    ];
    const { fetchImpl, calls } = makeFetch(responses);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await sendDiscordMessages({
      webhookUrl: 'https://discord.test/hook',
      messages: [{ content: 'x' }],
      fetchImpl,
      interMessageDelayMs: 0,
      sleepFn,
    });
    expect(calls.length).toBe(3);
  });

  test('non-2xx 4xx (not 429) throws without retry', async () => {
    const { fetchImpl, calls } = makeFetch([new Response('bad', { status: 400 })]);
    await expect(
      sendDiscordMessages({
        webhookUrl: 'https://discord.test/hook',
        messages: [{ content: 'x' }],
        fetchImpl,
        interMessageDelayMs: 0,
      }),
    ).rejects.toThrow(/Discord 400/);
    expect(calls.length).toBe(1);
  });

  test('exhausted retries throw', async () => {
    const responses = [
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
      new Response('', { status: 503 }),
    ];
    const { fetchImpl } = makeFetch(responses);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await expect(
      sendDiscordMessages({
        webhookUrl: 'https://discord.test/hook',
        messages: [{ content: 'x' }],
        fetchImpl,
        interMessageDelayMs: 0,
        sleepFn,
      }),
    ).rejects.toThrow(/Discord 503/);
  });

  test('sleeps between messages by configured delay', async () => {
    const { fetchImpl } = makeFetch([makeOkResponse(), makeOkResponse()]);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    await sendDiscordMessages({
      webhookUrl: 'https://discord.test/hook',
      messages: [{ content: 'a' }, { content: 'b' }],
      fetchImpl,
      interMessageDelayMs: 250,
      sleepFn,
    });
    // sleepFn called once between the two messages.
    const callsWith250 = sleepFn.mock.calls.filter((c) => c[0] === 250);
    expect(callsWith250.length).toBe(1);
  });
});
