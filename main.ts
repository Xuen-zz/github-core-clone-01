// Entry lifecycle: bind an ephemeral port, register it with the grading env,
// poll /done until the trial is over, then exit 0.
//
// The env owns port 8080 and is named by MAKEFUN_ENV_URL. The forge itself is built
// by createForge() in src/server.ts; this file only owns the process lifecycle.

import { createForge } from './src/server.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, nothing to register with\n');
  process.exit(1);
}

const TIMEOUT_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(2000, 250 * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await wait(backoff(attempt));
  }
}

async function waitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env not answering yet: keep polling.
    }
    await wait(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createForge();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server did not bind a TCP port');
  process.stdout.write(`[forge] listening on ${addr.port}\n`);
  await register(addr.port);
  process.stdout.write('[forge] registered\n');
  await waitDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
