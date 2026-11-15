// Entry point: the forge's life is the trial's life. This process starts the HTTP server
// from app.ts on a port the kernel chooses, tells the contest env where it can be reached,
// and then stays alive, polling, until the env reports the trial finished. Only then does
// it close the server and exit successfully, because the env writes the export the scorer
// reads from what the server answered while it lived.
//
// The env's origin arrives as MAKEFUN_ENV_URL. The register call carries {"port": N}; the
// first registration wins, so a conflict answer simply means this process was not first
// and it carries on waiting like any other. Polls and registrations that fail at the
// network level are retried with a growing wait: the env may still be starting, and
// leaving early would score the trial zero.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL missing: no env to register with\n');
  process.exit(1);
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Backoff between retries of a failed env call: 250ms doubling to a 2s ceiling. */
function backoff(failures: number): number {
  const grown = 250 * 2 ** Math.min(failures, 8);
  return Math.min(2_000, grown);
}

async function callEnv(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${envOrigin}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
}

/** Announce the bound port; contract answers (400, 405) are fatal, the rest are retried. */
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatal: Error | null = null;
    try {
      const res = await callEnv('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // A network failure means the env is not up yet; fall through to the retry wait.
    }
    if (fatal) throw fatal;
    await pause(backoff(failures));
    failures += 1;
  }
}

/** True once the env answers the done poll with {"done": true}; polls forever until then. */
async function envFinished(): Promise<boolean> {
  try {
    const res = await callEnv('/done');
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const bound = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  const port = await bound;
  process.stdout.write(`[forge] listening on port ${port}\n`);

  await announce(port);
  process.stdout.write('[forge] registered; waiting for the env to finish\n');

  let failures = 0;
  while (!(await envFinished())) {
    await pause(backoff(failures));
    failures += 1;
  }

  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
