// src/sources/browser-bridge.ts
//
// Generic shell-out wrapper around a "browser-bridge" CLI. The bridge is a
// separate, user-supplied binary that drives a logged-in Chrome profile and
// scrapes Canvas. It is an OPTIONAL fallback for schools that block Canvas API
// access tokens; the default source is the Canvas REST API (see canvas-api.ts).
//
// This wrapper spawns the binary, pipes a JSON body on stdin, parses the JSON
// envelope on stdout, and surfaces the {ok, result, error} shape upstream. It
// never throws on adapter or transport failure - the caller decides what to do
// with a degraded envelope.
//
// The bridge binary path has no default: set BROWSER_BRIDGE_PATH (or pass
// binaryPath) when you opt into the browser-bridge source.

import { spawn } from 'node:child_process';

export const DEFAULT_PROFILE_NAME = 'canvas-digest';

export const DEFAULT_TIMEOUT_MS = 60_000;

export interface BrowserBridgeError {
  code: string;
  message: string;
}

export interface BrowserBridgeResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: BrowserBridgeError;
  warnings?: unknown[];
  raw?: unknown;
}

export interface BrowserBridgeInvokeArgs {
  platform: string;
  action: string;
  input?: Record<string, unknown>;
  profileName?: string;
  timeoutMs?: number;
}

export interface BrowserBridgeRunner {
  invoke<T = unknown>(args: BrowserBridgeInvokeArgs): Promise<BrowserBridgeResponse<T>>;
}

export interface BrowserBridgeShellRunnerOptions {
  binaryPath?: string;
  logger?: (msg: string) => void;
  // Override the spawn function for testing.
  spawnFn?: typeof spawn;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runChild(
  spawnFn: typeof spawn,
  cmd: string,
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawnFn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let killTimer: NodeJS.Timeout | null = null;
    let resolved = false;
    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr, code, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      // SIGTERM is advisory; a wedged child (stuck Playwright / hung Chrome)
      // can ignore it. Escalate to SIGKILL after a grace period and resolve
      // the outer promise even if the child never reports close, so callers
      // do not hang.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish(null);
      }, 5_000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (resolved) return;
      resolved = true;
      reject(err);
    });
    child.on('close', (code) => {
      finish(code);
    });

    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export function parseBrowserBridgeEnvelope<T = unknown>(stdout: string): BrowserBridgeResponse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_envelope',
        message: `browser-bridge returned non-JSON: ${(err as Error).message}`,
      },
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: { code: 'invalid_envelope', message: 'browser-bridge envelope is not an object' },
    };
  }

  const env = parsed as {
    ok?: unknown;
    result?: unknown;
    error?: unknown;
    warnings?: unknown;
  };

  if (env.ok === true) {
    return {
      ok: true,
      result: env.result as T,
      warnings: Array.isArray(env.warnings) ? env.warnings : undefined,
      raw: parsed,
    };
  }

  const rawErr = env.error as { code?: unknown; message?: unknown } | null | undefined;
  return {
    ok: false,
    error: {
      code: rawErr?.code !== undefined ? String(rawErr.code) : 'adapter_error',
      message: rawErr?.message !== undefined ? String(rawErr.message) : '',
    },
    warnings: Array.isArray(env.warnings) ? env.warnings : undefined,
    raw: parsed,
  };
}

export class BrowserBridgeShellRunner implements BrowserBridgeRunner {
  private readonly binaryPath: string;
  private readonly logger?: (msg: string) => void;
  private readonly spawnFn: typeof spawn;

  constructor(opts: BrowserBridgeShellRunnerOptions = {}) {
    // The browser-bridge binary is user-supplied and has no default location.
    // Resolve from explicit option, then BROWSER_BRIDGE_PATH. If neither is
    // set, every invoke() short-circuits to a runner_failed envelope so the
    // pipeline degrades instead of crashing.
    this.binaryPath = opts.binaryPath ?? process.env.BROWSER_BRIDGE_PATH ?? '';
    this.logger = opts.logger;
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  async invoke<T = unknown>(args: BrowserBridgeInvokeArgs): Promise<BrowserBridgeResponse<T>> {
    if (!this.binaryPath) {
      const msg =
        'browser-bridge binary path not configured: set BROWSER_BRIDGE_PATH or pass binaryPath';
      this.logger?.(msg);
      return { ok: false, error: { code: 'runner_failed', message: msg } };
    }
    const profile = args.profileName ?? DEFAULT_PROFILE_NAME;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const stdin = JSON.stringify(args.input ?? {});
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BROWSER_BRIDGE_PROFILE_NAME: profile,
    };
    const cliArgs = [this.binaryPath, args.platform, args.action];

    try {
      const { stdout, stderr, code, timedOut } = await runChild(
        this.spawnFn,
        'node',
        cliArgs,
        stdin,
        env,
        timeoutMs,
      );

      if (timedOut) {
        this.logger?.(
          `browser-bridge timed out platform=${args.platform} action=${args.action} after ${timeoutMs}ms`,
        );
        return {
          ok: false,
          error: { code: 'timeout', message: `timed out after ${timeoutMs}ms` },
        };
      }

      if (!stdout) {
        this.logger?.(
          `browser-bridge produced no stdout platform=${args.platform} action=${args.action} code=${code} stderr=${truncate(stderr, 200)}`,
        );
        return {
          ok: false,
          error: {
            code: 'no_output',
            message: `browser-bridge exited ${code} with no stdout: ${truncate(stderr, 200)}`,
          },
        };
      }

      const envelope = parseBrowserBridgeEnvelope<T>(stdout);
      if (!envelope.ok) {
        this.logger?.(
          `browser-bridge envelope error platform=${args.platform} action=${args.action} code=${envelope.error?.code} message=${truncate(envelope.error?.message ?? '', 200)}`,
        );
      }
      return envelope;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.(`browser-bridge spawn failed: ${truncate(msg, 200)}`);
      return {
        ok: false,
        error: { code: 'runner_failed', message: msg },
      };
    }
  }
}
