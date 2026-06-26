import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  BrowserBridgeShellRunner,
  parseBrowserBridgeEnvelope,
} from '../../src/sources/browser-bridge.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: { write: (s: string) => void; end: () => void };
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  writtenStdin = '';

  constructor() {
    super();
    this.stdin = {
      write: (s: string) => {
        this.writtenStdin += s;
      },
      end: () => {
        /* noop */
      },
    };
  }

  kill(signal?: NodeJS.Signals) {
    this.killed = true;
    this.killSignal = signal ?? null;
    return true;
  }

  // Emit stdout + close synchronously-ish on next microtask.
  finish(stdout: string, stderr: string, code: number) {
    queueMicrotask(() => {
      if (stdout) this.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      if (stderr) this.stderr.emit('data', Buffer.from(stderr, 'utf8'));
      this.emit('close', code);
    });
  }
}

function fakeSpawn(child: FakeChild) {
  return (() => child) as unknown as typeof import('node:child_process').spawn;
}

describe('parseBrowserBridgeEnvelope', () => {
  test('parses ok envelope into result', () => {
    const env = parseBrowserBridgeEnvelope<{ x: number }>('{"ok":true,"result":{"x":1}}');
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ x: 1 });
  });

  test('parses adapter error envelope', () => {
    const env = parseBrowserBridgeEnvelope(
      '{"ok":false,"result":null,"error":{"code":"not_logged_in","message":"saml expired"}}',
    );
    expect(env.ok).toBe(false);
    expect(env.error).toEqual({ code: 'not_logged_in', message: 'saml expired' });
  });

  test('degrades on non-JSON stdout', () => {
    const env = parseBrowserBridgeEnvelope('garbage');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('invalid_envelope');
  });

  test('degrades on non-object JSON', () => {
    const env = parseBrowserBridgeEnvelope('[]');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('invalid_envelope');
  });

  test('treats missing error.code as adapter_error', () => {
    const env = parseBrowserBridgeEnvelope('{"ok":false}');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('adapter_error');
  });
});

describe('BrowserBridgeShellRunner', () => {
  test('pipes stdin JSON, sets profile env var, parses ok envelope', async () => {
    const child = new FakeChild();
    let capturedArgs: string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    const spawnFn = ((_cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedArgs = args;
      capturedEnv = opts.env ?? {};
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const runner = new BrowserBridgeShellRunner({
      binaryPath: '/fake/bin/browser-bridge.js',
      spawnFn,
    });

    const promise = runner.invoke({
      platform: 'canvas',
      action: 'list-courses',
      input: { limit: 5 },
      profileName: 'my-profile',
    });
    child.finish('{"ok":true,"result":{"courses":[]}}', '', 0);
    const env = await promise;

    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ courses: [] });
    expect(capturedArgs).toEqual(['/fake/bin/browser-bridge.js', 'canvas', 'list-courses']);
    expect(capturedEnv.BROWSER_BRIDGE_PROFILE_NAME).toBe('my-profile');
    expect(child.writtenStdin).toBe('{"limit":5}');
  });

  test('defaults profileName to canvas-digest when absent', async () => {
    const child = new FakeChild();
    let capturedEnv: NodeJS.ProcessEnv = {};
    const spawnFn = ((_c: string, _a: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = opts.env ?? {};
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const runner = new BrowserBridgeShellRunner({ binaryPath: '/x', spawnFn });
    const promise = runner.invoke({ platform: 'canvas', action: 'status' });
    child.finish('{"ok":true,"result":{}}', '', 0);
    await promise;
    expect(capturedEnv.BROWSER_BRIDGE_PROFILE_NAME).toBe('canvas-digest');
  });

  test('returns runner_failed when no binary path is configured', async () => {
    const prev = process.env.BROWSER_BRIDGE_PATH;
    delete process.env.BROWSER_BRIDGE_PATH;
    try {
      const runner = new BrowserBridgeShellRunner();
      const env = await runner.invoke({ platform: 'canvas', action: 'status' });
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('runner_failed');
      expect(env.error?.message).toContain('BROWSER_BRIDGE_PATH');
    } finally {
      if (prev !== undefined) process.env.BROWSER_BRIDGE_PATH = prev;
    }
  });

  test('returns timeout envelope without throwing', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawnFn = fakeSpawn(child);
    const runner = new BrowserBridgeShellRunner({ binaryPath: '/x', spawnFn });

    const promise = runner.invoke({
      platform: 'canvas',
      action: 'list-courses',
      timeoutMs: 10,
    });
    vi.advanceTimersByTime(20);
    // Even after kill the child must emit close for the spawn promise to resolve.
    queueMicrotask(() => child.emit('close', null));
    vi.useRealTimers();
    const env = await promise;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('timeout');
    expect(child.killed).toBe(true);
  });

  test('returns no_output envelope when child exits with empty stdout', async () => {
    const child = new FakeChild();
    const spawnFn = fakeSpawn(child);
    const runner = new BrowserBridgeShellRunner({ binaryPath: '/x', spawnFn });
    const promise = runner.invoke({ platform: 'canvas', action: 'status' });
    child.finish('', 'boom', 1);
    const env = await promise;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('no_output');
    expect(env.error?.message).toContain('boom');
  });

  test('returns runner_failed envelope on spawn error', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT node');
    }) as unknown as typeof import('node:child_process').spawn;
    const runner = new BrowserBridgeShellRunner({ binaryPath: '/x', spawnFn });
    const env = await runner.invoke({ platform: 'canvas', action: 'status' });
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('runner_failed');
    expect(env.error?.message).toContain('ENOENT');
  });

  test('parses adapter error envelope from stdout', async () => {
    const child = new FakeChild();
    const spawnFn = fakeSpawn(child);
    const runner = new BrowserBridgeShellRunner({ binaryPath: '/x', spawnFn });
    const promise = runner.invoke({ platform: 'canvas', action: 'list-courses' });
    child.finish(
      '{"ok":false,"result":null,"error":{"code":"not_logged_in","message":"reauth"}}',
      '',
      2,
    );
    const env = await promise;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('not_logged_in');
  });

  test('resolves a timeout envelope even when the child never emits close', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const spawnFn = fakeSpawn(child);
      const runner = new BrowserBridgeShellRunner({ binaryPath: '/x', spawnFn });
      const promise = runner.invoke({
        platform: 'canvas',
        action: 'status',
        timeoutMs: 1_000,
      });
      // Advance past the SIGTERM timer, then past the SIGKILL grace timer.
      // The child never emits close to simulate a wedged Playwright child.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const env = await promise;
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('timeout');
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
