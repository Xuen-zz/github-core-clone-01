// MCP over streamable HTTP (JSON-RPC 2.0) at POST /mcp.
//
// Two eras: modern 2026-07-28 (`server/discover`, no handshake) and legacy
// 2025-11-25 and earlier (`initialize` + `notifications/initialized` +
// `Mcp-Session-Id`). Plain JSON responses: the client reads a JSON body fine, so
// no SSE stream is needed. Auth is enforced by server.ts before this handler runs
// (401 without the shop token). The six tools write through the same Store
// primitives the REST routes use, so an MCP write is visible over REST.
//
// A body that is not JSON answers HTTP 400 with JSON-RPC -32700; an unknown tool
// answers -32602 (never HTTP 500); a call without its required arguments answers
// isError:true; every response echoes the request's id.

import type { ForgeRequest, ForgeResponse } from './transport.ts';
import { ApiError, mergePull, type Ctx } from './rest.ts';
import { VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** A tool call that cannot run (bad arguments, missing object, conflict). */
class ToolArgError extends Error {}

// ---------------------------------------------------------------- protocol

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

/** Revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const MCP_UNSUPPORTED_VERSION = -32022;

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

// ---------------------------------------------------------------- tools

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/** The tool list is a module constant, so two tools/list answers are byte-identical. */
const TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (the authenticated user).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoResult(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.seq + 1,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
  };
}

function issueResult(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.seq * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullResult(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.seq * 100000 + 50000 + pull.number,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    merged: pull.merged,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function findRepo(ctx: Ctx, args: Record<string, unknown>): Repo {
  const owner = asStr(args.owner);
  const name = asStr(args.repo !== undefined ? args.repo : args.name);
  const repo = owner === '' || name === '' ? undefined : ctx.store.getRepo(owner, name);
  if (repo === undefined) throw new ToolArgError(`Repository not found: ${owner}/${name}`);
  return repo;
}

function toolCreateRepo(ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const name = asStr(args.name);
  if (name === '') throw new ToolArgError('name is required');
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    throw new ToolArgError(`Repository already exists: ${name}`);
  }
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, args.private === true, asStr(args.description));
  return repoResult(ctx, repo);
}

function toolGetRepo(ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  return repoResult(ctx, findRepo(ctx, args));
}

function toolCreateIssue(ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const repo = findRepo(ctx, args);
  const title = asStr(args.title);
  if (title === '') throw new ToolArgError('title is required');
  const sec = ctx.store.clock.tick();
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body: asStr(args.body),
    state: 'open',
    labels: [],
    comments: [],
    seq: repo.nextIssue,
    createdSec: sec,
    updatedSec: sec,
  };
  repo.issues.push(issue);
  return issueResult(ctx, repo, issue);
}

function toolListIssues(ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const repo = findRepo(ctx, args);
  const state = asStr(args.state, 'open');
  const list = repo.issues.filter((i) => state === 'all' || i.state === state);
  const issues = list.map((i) => issueResult(ctx, repo, i));
  return { issues, total_count: issues.length };
}

function toolCreatePullRequest(ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const repo = findRepo(ctx, args);
  const headRef = asStr(args.head);
  const baseRef = asStr(args.base, repo.defaultBranch);
  const title = asStr(args.title);
  if (headRef === '' || title === '') throw new ToolArgError('head and title are required');
  const headSha = ctx.store.resolveRef(repo, headRef);
  const baseSha = ctx.store.resolveRef(repo, baseRef);
  if (headSha === '' || baseSha === '') throw new ToolArgError('head or base branch does not exist');
  const sec = ctx.store.clock.tick();
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body: asStr(args.body),
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    seq: repo.nextPull,
    createdSec: sec,
    updatedSec: sec,
  };
  repo.pulls.push(pull);
  return pullResult(ctx, repo, pull);
}

function toolMergePullRequest(ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const repo = findRepo(ctx, args);
  const n =
    typeof args.pull_number === 'number'
      ? args.pull_number
      : typeof args.number === 'number'
        ? args.number
        : NaN;
  if (!Number.isFinite(n)) throw new ToolArgError('pull_number is required');
  const pull = repo.pulls.find((p) => p.number === n);
  if (pull === undefined) throw new ToolArgError(`Pull request not found: #${n}`);
  // Same squash merge the REST route runs (throws ApiError on conflict/closed).
  mergePull(ctx, repo, pull);
  return { ...pullResult(ctx, repo, pull), merged: true };
}

const TOOL_HANDLERS: Record<string, (ctx: Ctx, args: Record<string, unknown>) => Record<string, unknown>> = {
  create_repo: toolCreateRepo,
  get_repo: toolGetRepo,
  create_issue: toolCreateIssue,
  list_issues: toolListIssues,
  create_pull_request: toolCreatePullRequest,
  merge_pull_request: toolMergePullRequest,
};

/** A successful tool call: text content plus structured content, both carrying the result. */
function toolOk(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

/** A tool call that cannot run: isError:true with the reason as text. */
function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- dispatch

function dispatchOne(ctx: Ctx, parsed: unknown): Record<string, unknown> | null {
  if (!isRecord(parsed)) return rpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  const id = parsed.id;
  const method = parsed.method;
  if (typeof method !== 'string' || method === '') {
    return rpcError(id ?? null, JSON_RPC_INVALID_REQUEST, 'Invalid Request');
  }
  const isNotification = parsed.id === undefined;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // The revision this request declares must be one this server speaks.
  const meta = isRecord(params._meta) ? params._meta : {};
  const declared = meta['io.modelcontextprotocol/protocolVersion'];
  if (
    typeof declared === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(declared) &&
    !SUPPORTED_VERSIONS.includes(declared)
  ) {
    return rpcError(id ?? null, MCP_UNSUPPORTED_VERSION, 'Unsupported protocol version', {
      supported: [...SUPPORTED_VERSIONS],
    });
  }

  if (method === 'server/discover') {
    return rpcResult(id ?? null, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
    return rpcResult(id ?? null, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method.startsWith('notifications/')) {
    // A notification has no response; the handler answers 202 with an empty body.
    return null;
  }

  if (method === 'ping') return rpcResult(id ?? null, {});

  if (method === 'tools/list') {
    return rpcResult(id ?? null, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (typeof name !== 'string' || name === '') {
      return rpcError(id ?? null, JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name');
    }
    const def = TOOLS.find((t) => t.name === name);
    const handler = TOOL_HANDLERS[name];
    if (def === undefined || handler === undefined) {
      return rpcError(id ?? null, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const missing = def.inputSchema.required.filter((p) => args[p] === undefined || args[p] === null);
    if (missing.length > 0) {
      return rpcResult(id ?? null, toolFail(`Missing required argument(s): ${missing.join(', ')}`));
    }
    try {
      return rpcResult(id ?? null, toolOk(handler(ctx, args)));
    } catch (e) {
      if (e instanceof ToolArgError || e instanceof ApiError) {
        return rpcResult(id ?? null, toolFail(e.message));
      }
      process.stderr.write(
        `[forge] mcp tools/call ${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
      return rpcResult(id ?? null, toolFail(e instanceof Error ? e.message : 'Internal error.'));
    }
  }

  return rpcError(id ?? null, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- HTTP handler

export async function handleMcp(
  ctx: Ctx,
  req: ForgeRequest,
  res: ForgeResponse,
  _url: URL,
  _body: unknown,
  rawBody: Buffer,
  baseHeaders: Record<string, string>,
): Promise<boolean> {
  if (req.url === undefined) return false;
  const path = new URL(req.url, 'http://entry').pathname;
  if (path !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') return false;

  const sendJson = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void => {
    const text = `${JSON.stringify(payload)}\n`;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...baseHeaders,
      ...extraHeaders,
    });
    res.end(text);
  };

  // Parse the raw body here: a body that is not JSON is a JSON-RPC parse error
  // (-32700), not the shared JSON parser's 400.
  let parsed: unknown;
  try {
    parsed = rawBody.length === 0 ? null : JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(400, rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error'));
    return true;
  }

  if (Array.isArray(parsed)) {
    const out = parsed.map((item) => dispatchOne(ctx, item)).filter((r) => r !== null);
    sendJson(200, out);
    return true;
  }

  const out = dispatchOne(ctx, parsed);
  if (out === null) {
    // A notification: 202 with an empty body.
    res.writeHead(202, { ...baseHeaders });
    res.end();
    return true;
  }
  // The legacy handshake hands out a session id the client echoes back.
  const extra: Record<string, string> =
    isRecord(parsed) && parsed.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {};
  sendJson(200, out, extra);
  return true;
}
