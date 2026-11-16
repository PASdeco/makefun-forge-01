// The forge's HTTP surface: auth and wire discipline in front of the four surfaces
// (REST v3, GraphQL v4, MCP, git smart HTTP), all over one shared Forge store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './lib/store.ts';
import { BAD_JSON, parseBody, routeRest, type HttpResult } from './lib/rest.ts';
import { isGitPath, routeGit } from './lib/gitproto.ts';
import { executeGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY = 256 * 1024 * 1024;

let requestCounter = 0;

function send(res: ServerResponse, result: HttpResult): void {
  requestCounter += 1;
  const headers: Record<string, string> = {
    'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`,
    ...(result.headers ?? {}),
  };
  if (result.rawBody !== undefined) {
    headers['content-type'] = result.contentType ?? 'application/octet-stream';
    headers['content-length'] = String(result.rawBody.length);
    res.writeHead(result.status, headers);
    res.end(result.rawBody);
    return;
  }
  if (result.body === undefined) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(result.body);
  headers['content-type'] = result.contentType ?? JSON_TYPE;
  headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(result.status, headers);
  res.end(text);
}

/** Write an already-serialized JSON body (the GET response cache's hit path). */
function sendText(res: ServerResponse, status: number, text: string, headers?: Record<string, string>): void {
  requestCounter += 1;
  res.writeHead(status, {
    'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`,
    ...(headers ?? {}),
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

export function createApp(): Server {
  const forge = new Forge();
  // GET response cache for the REST surface. A REST response body is a pure
  // function of the store, and every store change arrives through a non-GET
  // request, so a cached body stays valid until the next non-GET request
  // bumps the mutation version. An entry carries the version it was built
  // under and is served only while that version is still current, so a
  // mutation interleaved with a read can never leave a stale body servable.
  const getCache = new Map<string, { version: number; status: number; text: string; headers?: Record<string, string> }>();
  let mutationVersion = 0;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          send(res, { status: 200, body: { ok: true } });
          return;
        }

        if (!authorized(req)) {
          send(res, { status: 401, body: { message: 'Bad credentials' } });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const host = req.headers.host ?? 'localhost';

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitPath = isGitPath(path);
        if (gitPath) {
          if (method !== 'GET') mutationVersion += 1;
          const gitResult = await routeGit(forge, method, gitPath, url.searchParams, body, req.headers['git-protocol']);
          if (method !== 'GET') mutationVersion += 1;
          send(res, gitResult);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const isGet = method === 'GET';
          if (!isGet) mutationVersion += 1;
          const cacheKey = isGet ? `${host} ${path}?${url.searchParams.toString()}` : '';
          if (isGet) {
            const hit = getCache.get(cacheKey);
            if (hit && hit.version === mutationVersion) {
              sendText(res, hit.status, hit.text, hit.headers);
              return;
            }
          }
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment.length > 0)
            .map((segment) => decodeURIComponent(segment));
          const parsed = isGet ? undefined : parseBody(body);
          const result = routeRest(forge, method, segments, url.searchParams, parsed === undefined ? {} : parsed, host);
          if (!isGet) mutationVersion += 1;
          if (isGet && result.status === 200 && result.body !== undefined && result.rawBody === undefined) {
            if (getCache.size > 2048) getCache.clear();
            getCache.set(cacheKey, { version: mutationVersion, status: result.status, text: JSON.stringify(result.body), headers: result.headers });
          }
          send(res, result);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          const parsed = parseBody(body);
          if (parsed === BAD_JSON || parsed === undefined) {
            send(res, { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } });
            return;
          }
          const result = executeGraphQL(forge, parsed);
          mutationVersion += 1;
          send(res, { status: result.status, body: result.body });
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            send(res, { status: 405, body: { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } } });
            return;
          }
          const parsed = parseBody(body);
          if (parsed === BAD_JSON || parsed === undefined) {
            send(res, { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } });
            return;
          }
          const outcome = handleMcp(forge, parsed);
          mutationVersion += 1;
          send(res, { status: outcome.status, body: outcome.body, headers: outcome.headers });
          return;
        }

        send(res, { status: 404, body: { message: 'Not Found' } });
      } catch {
        try {
          send(res, { status: 500, body: { message: 'Internal error' } });
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    })();
  });
}
