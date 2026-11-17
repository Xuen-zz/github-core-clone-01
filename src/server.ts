// HTTP server: routing, auth, request ids and the JSON discipline every surface
// shares. The four surfaces live in their own modules (rest, git-http, graphql, mcp).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { ApiError, restRoutes, type Ctx, type Reply } from './rest.ts';
import { handleGitHttp } from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
}

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m !== null ? (m[1] as string) : '';
}

/** The request id every reply carries (non-empty; format is free). */
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}${Date.now().toString(36)}`;
}

export function createForge(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = nextRequestId();
    const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const host = req.headers.host ?? '127.0.0.1';
      const baseUrl = `http://${host}`;

      // The env's boot probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, baseHeaders);
        return;
      }

      const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp';
      if (isApi) {
        // Auth: the shop token this process received; missing or wrong is 401.
        const presented = bearerToken(req);
        if (token !== '' && presented !== token) {
          sendJson(res, 401, { message: 'Bad credentials' }, baseHeaders);
          return;
        }
        if (token === '' && presented === '') {
          sendJson(res, 401, { message: 'Bad credentials' }, baseHeaders);
          return;
        }
      }

      const rawBody = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? await readBody(req).catch(() => Buffer.alloc(0)) : await readBody(req);
      // DELETE with a body (contents delete sends one): parse it too. /mcp parses
      // its own raw body: a non-JSON body there is a JSON-RPC -32700, not this 400.
      const body = isApi && rawBody.length > 0 && path !== '/mcp' ? parseJson(rawBody) : null;

      const ctx: Ctx = { store, token, baseUrl };

      // REST v3 routes.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        for (const route of restRoutes) {
          if (route.method !== method) continue;
          const m = route.pattern.exec(path);
          if (m === null) continue;
          const params: Record<string, string> = {};
          route.keys.forEach((k, i) => {
            params[k] = decodeURIComponent(m[i + 1] as string);
          });
          const out: Reply = await route.handler(ctx, { method, path, query: url.searchParams, params, body });
          sendJson(res, out.status, out.body, { ...baseHeaders, ...(out.headers ?? {}) });
          return;
        }
        // Unknown /api/v3 route: JSON 404.
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
        return;
      }

      // Git smart HTTP, GraphQL and MCP.
      if (path === '/api/graphql' || path === '/mcp' || path.includes('.git/')) {
        if (await handleGitHttp(ctx, req, res, url, rawBody, baseHeaders)) return;
        if (await handleGraphql(ctx, req, res, url, body, baseHeaders)) return;
        if (await handleMcp(ctx, req, res, url, body, rawBody, baseHeaders)) return;
      }

      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { message: err.message }, baseHeaders);
        return;
      }
      process.stderr.write(`[forge] unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, baseHeaders);
      else res.end();
    }
  });
}

// Re-exported for the git/graphql/mcp modules.
export { sendJson, sendRaw, readBody, parseJson, bearerToken };
