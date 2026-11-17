// Raw TCP HTTP/1.1 transport: a hand-written request parser plus minimal
// IncomingMessage/ServerResponse stand-ins, so the forge's handlers run unchanged
// on top of net.Socket instead of node:http.
//
// Why: node:http costs ~200 µs of server CPU per request (C++ parser, stream
// machinery, object allocation); the benchmark is latency-bound on sequential
// keep-alive requests, so the transport is the bottleneck. This parser does one
// Buffer.indexOf for the header block, a small split for headers, zero-copy body
// slicing, and one socket.write per response.
//
// The stand-ins cover exactly the surface the handlers use:
//   req: method, url, headers, on('data'|'end'|'error'), destroy()
//   res: writeHead(status, headers), end(body?), headersSent
// Anything else (chunked request bodies, Connection: close, HEAD) is handled
// explicitly below. `Expect: 100-continue` is not sent by the harness clients
// (fetch/undici), so it is not special-cased.

import { createServer, type Server, type Socket } from 'node:net';

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

// ---------------------------------------------------------------- fake request

export class ForgeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly httpVersion = '1.1';
  private readonly body: Buffer;
  private readonly socket: Socket;
  private dataSent = false;
  private endSent = false;

  constructor(method: string, url: string, headers: Record<string, string>, body: Buffer, socket: Socket) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
    this.socket = socket;
  }

  /** Stream delivery for readBody: the body is already buffered, so listeners fire
   * synchronously on registration (data first, then end) — no extra tick. */
  on(event: string, fn: (arg?: unknown) => void): this {
    if (event === 'data') {
      if (this.body.length > 0 && !this.dataSent) {
        this.dataSent = true;
        (fn as (chunk: Buffer) => void)(this.body);
      }
    } else if (event === 'end') {
      if (!this.endSent) {
        this.endSent = true;
        (fn as () => void)();
      }
    }
    // 'error' never fires for a buffered body; stored nowhere, nothing to do.
    return this;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------- fake response

export class ForgeResponse {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private ended = false;
  private readonly socket: Socket;
  private readonly method: string;
  private readonly keepAlive: boolean;

  constructor(socket: Socket, method: string, keepAlive: boolean) {
    this.socket = socket;
    this.method = method;
    this.keepAlive = keepAlive;
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = { ...headers };
    this.headersSent = true;
    return this;
  }

  /** Assemble the whole response and write it in one socket.write. */
  end(body?: Buffer | string): void {
    if (this.ended) return;
    this.ended = true;
    const payload =
      body === undefined || body === null
        ? Buffer.alloc(0)
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : body;
    const isHead = this.method === 'HEAD';
    const hasLength = this.headers['content-length'] !== undefined;
    let head = `HTTP/1.1 ${this.status} ${REASONS[this.status] ?? 'OK'}\r\n`;
    for (const key of Object.keys(this.headers)) head += `${key}: ${this.headers[key]}\r\n`;
    if (!this.keepAlive) head += 'connection: close\r\n';
    // Single allocation for head + payload (Buffer.concat would allocate the head
    // string buffer and then copy it again); chunked only when no Content-Length.
    if (!hasLength) {
      head += 'transfer-encoding: chunked\r\n';
      const headBuf = Buffer.from(`${head}\r\n`, 'ascii');
      const parts: Buffer[] = [headBuf];
      if (!isHead && payload.length > 0) {
        parts.push(
          Buffer.from(`${payload.length.toString(16)}\r\n`, 'ascii'),
          payload,
          Buffer.from('\r\n', 'ascii'),
        );
      }
      parts.push(Buffer.from('0\r\n\r\n', 'ascii'));
      const out = Buffer.concat(parts);
      if (!this.socket.destroyed) this.socket.write(out);
    } else {
      const headBuf = Buffer.from(`${head}\r\n`, 'ascii');
      const out = Buffer.allocUnsafe(headBuf.length + (isHead ? 0 : payload.length));
      headBuf.copy(out, 0);
      if (!isHead) payload.copy(out, headBuf.length);
      if (!this.socket.destroyed) {
        // Keep-alive (the common case): no write callback — it only closes the
        // socket, which is a no-op here, and costs a closure + a tick per response.
        if (this.keepAlive) this.socket.write(out);
        else this.socket.write(out, () => this.socket.end());
      }
    }
  }
}

// ---------------------------------------------------------------- parser

interface ParsedRequest {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: Buffer;
  httpVersion: string;
  keepAlive: boolean;
}

/**
 * Parse the request line + headers directly from the buffer (no split array, no
 * whole-block string): scan for CRLF line ends and ':' separators, slicing each
 * name/value out. Header names arrive lowercase from the harness clients; the
 * lowercasing pass only runs when a name actually contains an uppercase byte.
 */
function parseHeaders(buf: Buffer, headerEnd: number): { method: string; target: string; version: string; headers: Record<string, string> } {
  const sp1 = buf.indexOf(0x20, 0);
  const sp2 = buf.indexOf(0x20, sp1 + 1);
  if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
  const lineEnd = buf.indexOf(0x0d, sp2 + 1);
  if (lineEnd < 0 || lineEnd > headerEnd) throw new Error('bad request line');
  const method = buf.subarray(0, sp1).toString('ascii');
  const target = buf.subarray(sp1 + 1, sp2).toString('ascii');
  const version = buf.subarray(sp2 + 1, lineEnd).toString('ascii');
  const headers: Record<string, string> = {};
  let pos = lineEnd + 2;
  while (pos < headerEnd) {
    const eol = buf.indexOf(0x0d, pos);
    if (eol < 0 || eol > headerEnd) break;
    const colon = buf.indexOf(0x3a, pos);
    if (colon < 0 || colon >= eol) {
      pos = eol + 2;
      continue;
    }
    let name = buf.subarray(pos, colon).toString('ascii').trim();
    // Fast path: names are already lowercase; only pay for toLowerCase when needed.
    for (let i = 0; i < name.length; i += 1) {
      const c = name.charCodeAt(i);
      if (c >= 65 && c <= 90) {
        name = name.toLowerCase();
        break;
      }
    }
    const value = buf.subarray(colon + 1, eol).toString('ascii').trim();
    const prev = headers[name];
    headers[name] = prev === undefined ? value : `${prev}, ${value}`;
    pos = eol + 2;
  }
  return { method, target, version, headers };
}

/** Parse one request from the front of `buf`, or null when more data is needed.
 * Throws on a malformed request or an over-limit body. */
function parseRequest(buf: Buffer): { req: ParsedRequest; consumed: number } | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('headers too large');
    return null;
  }
  const { method, target, version, headers } = parseHeaders(buf, headerEnd);
  const bodyStart = headerEnd + 4;
  const connection = (headers['connection'] ?? '').toLowerCase();
  const keepAlive = version === 'HTTP/1.1' ? connection !== 'close' : connection === 'keep-alive';
  const base = { method, target, headers, httpVersion: version, keepAlive };

  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  if (transferEncoding.includes('chunked')) {
    // Chunked request body (defensive: the harness clients send Content-Length).
    const chunks: Buffer[] = [];
    let total = 0;
    let pos = bodyStart;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd < 0) return null;
      const size = parseInt(buf.subarray(pos, lineEnd).toString('ascii').split(';')[0]?.trim() ?? '', 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
      pos = lineEnd + 2;
      if (size === 0) {
        // Trailer lines until an empty line.
        for (;;) {
          const eol = buf.indexOf('\r\n', pos);
          if (eol < 0) return null;
          if (eol === pos) {
            pos += 2;
            break;
          }
          pos = eol + 2;
        }
        return { req: { ...base, body: Buffer.concat(chunks) }, consumed: pos };
      }
      total += size;
      if (total > MAX_BODY_BYTES) throw new Error('request body too large');
      if (buf.length < pos + size + 2) return null;
      chunks.push(buf.subarray(pos, pos + size));
      pos += size + 2;
    }
  }

  const contentLength = headers['content-length'];
  if (contentLength !== undefined) {
    const len = parseInt(contentLength, 10);
    if (!Number.isFinite(len) || len < 0) throw new Error('bad content-length');
    if (len > MAX_BODY_BYTES) throw new Error('request body too large');
    if (buf.length < bodyStart + len) return null;
    return { req: { ...base, body: buf.subarray(bodyStart, bodyStart + len) }, consumed: bodyStart + len };
  }
  return { req: { ...base, body: Buffer.alloc(0) }, consumed: bodyStart };
}

// ---------------------------------------------------------------- server

export type ForgeHandler = (req: ForgeRequest, res: ForgeResponse) => Promise<void> | void;

/** A net.Server with the same listen/address/close/once surface main.ts uses,
 * serving the forge handler over hand-written HTTP/1.1. */
export function createRawServer(handler: ForgeHandler): Server {
  const server = createServer((socket) => {
    // Match node:http: Nagle off, or small request/response turns stall ~40 ms.
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let processing = false;
    let destroyed = false;

    const pump = async (): Promise<void> => {
      if (processing || destroyed) return;
      processing = true;
      try {
        for (;;) {
          let parsed: { req: ParsedRequest; consumed: number } | null;
          try {
            parsed = parseRequest(buf);
          } catch {
            // Malformed request: 400 and close, as node:http would.
            if (!socket.destroyed) {
              socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
              socket.destroy();
            }
            return;
          }
          if (parsed === null) return; // need more data
          buf = buf.subarray(parsed.consumed);
          const { req } = parsed;
          const keepAlive = req.keepAlive;
          const fakeReq = new ForgeRequest(req.method, req.target, req.headers, req.body, socket);
          const fakeRes = new ForgeResponse(socket, req.method, keepAlive);
          try {
            await handler(fakeReq, fakeRes);
          } catch {
            // The handler catches its own errors; this is a last resort.
            if (!fakeRes.headersSent && !socket.destroyed) {
              socket.write(
                'HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: 32\r\nconnection: close\r\n\r\n{"message":"Internal Server Error"}\n',
              );
            }
            socket.destroy();
            return;
          }
          if (!keepAlive || socket.destroyed) {
            socket.end();
            return;
          }
        }
      } finally {
        processing = false;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      void pump();
    });
    socket.on('error', () => {
      destroyed = true;
    });
    socket.on('close', () => {
      destroyed = true;
    });
  });
  return server;
}
