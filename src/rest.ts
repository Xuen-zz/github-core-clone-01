// GitHub REST v3 surface, as the suite drives it (checks-rest.ts).
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id. Errors are
// JSON {"message": string}. Missing or wrong Bearer token is 401; a repository under
// another owner is 404, never 403. Shapes assert only the listed fields; extra fields
// are allowed, so replies carry the usual GitHub fields.

import { Store, VIEWER_EMAIL, VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';
import { parseCommit, parseTree, serializeTree, treeSort } from './git-core.ts';

export interface Ctx {
  store: Store;
  token: string;
  baseUrl: string;
}

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: Ctx, req: Req) => Reply | Promise<Reply>;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function err(status: number, message: string): never {
  throw new ApiError(status, message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function reply(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

// ---------------------------------------------------------------- shapes

let nextEntityId = 1;
function newEntityId(): number {
  nextEntityId += 1;
  return nextEntityId;
}

export function userShape(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? 1000 : 1002, type: 'User', site_admin: false };
}

export function repoShape(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const t = ctx.store.clock.iso(1_735_689_600 + repo.seq);
  return {
    id: repo.seq + 1,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: t,
    updated_at: t,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
    clone_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}.git`,
    git_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function issueShape(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.seq * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: userShape(VIEWER_LOGIN),
    created_at: ctx.store.clock.iso(issue.createdSec),
    updated_at: ctx.store.clock.iso(issue.updatedSec),
    comments: issue.comments.length,
    comments_url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullShape(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.seq * 100000 + 50000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    user: userShape(VIEWER_LOGIN),
    created_at: ctx.store.clock.iso(pull.createdSec),
    updated_at: ctx.store.clock.iso(pull.updatedSec),
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- helpers

function requireRepo(ctx: Ctx, owner: string, name: string): Repo {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) err(404, 'Not Found');
  return repo as Repo;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; next: number | null } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), next: start + perPage < items.length ? page + 1 : null };
}

function linkFor(ctx: Ctx, path: string, query: URLSearchParams, next: number | null): Record<string, string> {
  if (next === null) return {};
  const q = new URLSearchParams(query);
  q.set('page', String(next));
  return { link: `<${ctx.baseUrl}${path}?${q.toString()}>; rel="next"` };
}

function messageOf(body: unknown): string {
  if (isObject(body) && typeof body.message === 'string' && body.message !== '') return body.message;
  return 'update';
}

export function tipTree(ctx: Ctx, repo: Repo, tip: string): string | null {
  if (tip === '') return null;
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Commit one file change (blobId null = delete) on a branch; returns the new commit id. */
function commitFile(ctx: Ctx, repo: Repo, branch: string, path: string, blobId: string | null, message: string): string {
  const ref = `refs/heads/${branch}`;
  const tip = ctx.store.refTip(repo, ref);
  const treeId = ctx.store.updateTree(repo, tipTree(ctx, repo, tip), path, blobId);
  const { id } = ctx.store.makeCommit(repo, treeId, tip === '' ? [] : [tip], message);
  repo.refs.set(ref, id);
  return id;
}

/** Line diff counts (LCS on lines; files in the checks are small). */
function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  const n = al.length;
  const m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = al[i] === bl[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  return { additions: additions + (m - j), deletions: deletions + (n - i) };
}

/** Merge-base: first commit on head's first-parent chain that is an ancestor of base tip. */
export function mergeBase(ctx: Ctx, repo: Repo, headTip: string, baseTip: string): string {
  const baseAncestors = ctx.store.ancestors(repo, baseTip);
  for (const id of ctx.store.firstParentHistory(repo, headTip)) {
    if (baseAncestors.has(id)) return id;
  }
  return '';
}

interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two trees (by root tree id) into a changed-file list. */
export function diffTrees(ctx: Ctx, repo: Repo, baseTree: string | null, headTree: string | null): ChangedFile[] {
  const base = baseTree === null ? new Map() : ctx.store.treePaths(repo, baseTree);
  const head = headTree === null ? new Map() : ctx.store.treePaths(repo, headTree);
  const out: ChangedFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) {
      const text = repo.objects.get(h.id)?.data.toString('utf8') ?? '';
      const additions = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const text = repo.objects.get(b.id)?.data.toString('utf8') ?? '';
      const deletions = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined && b.id !== h.id) {
      const a = repo.objects.get(b.id)?.data.toString('utf8') ?? '';
      const c = repo.objects.get(h.id)?.data.toString('utf8') ?? '';
      const d = lineDiff(a, c);
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- route table

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export const restRoutes: Route[] = [];

// Indexed dispatch: routes grouped by (method, segment[3], segment[6]) of the pattern,
// so a lookup tries only the few routes that can match (the hot GET-issue route used to
// be 19th of 28 regexes). The regex still decides the match; the index only narrows
// candidates, so matching behavior is unchanged.
const routeIndex = new Map<string, Route[]>();

function indexKey(method: string, parts: string[]): string {
  return `${method}|${parts[3] ?? ''}|${parts[6] ?? ''}`;
}

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/:[a-zA-Z_]+/g, (m) => {
        keys.push(m.slice(1));
        // `:path` is a file path and may contain slashes; every other param is one segment.
        return m === ':path' ? '(.+)' : '([^/]+)';
      }) +
      '$',
  );
  const entry: Route = { method, pattern: re, keys, handler };
  restRoutes.push(entry);
  const key = indexKey(method, pattern.split('/'));
  const group = routeIndex.get(key);
  if (group === undefined) routeIndex.set(key, [entry]);
  else group.push(entry);
}

/** Find the route for (method, path), or null when none matches. */
export function matchRestRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const group = routeIndex.get(indexKey(method, path.split('/')));
  if (group === undefined) return null;
  for (const route of group) {
    const m = route.pattern.exec(path);
    if (m === null) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] as string);
    });
    return { route, params };
  }
  return null;
}

route('GET', '/api/v3', () =>
  reply(200, {
    current_user_url: '/api/v3/user',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
  }, { 'x-oauth-scopes': 'repo, read:org' }),
);
route('GET', '/api/v3/', () =>
  reply(200, {
    current_user_url: '/api/v3/user',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
  }, { 'x-oauth-scopes': 'repo, read:org' }),
);

route('GET', '/api/v3/meta', () => reply(200, { installed_version: '1.0.0' }));

route('GET', '/api/v3/user', (ctx) => reply(200, { login: VIEWER_LOGIN, id: 1000, type: 'User', name: 'ada iversen', email: VIEWER_EMAIL }));

route('POST', '/api/v3/user/repos', (ctx, req) => {
  const body = isObject(req.body) ? req.body : {};
  const name = asString(body.name);
  if (name === '') err(422, 'name is required');
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) err(422, 'Repository already exists');
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, body.private === true, asString(body.description));
  return reply(201, repoShape(ctx, repo));
});

route('GET', '/api/v3/user/repos', (ctx, req) => {
  const { page, next } = paginate(ctx.store.viewerRepos(), req.query);
  return reply(200, page.map((r) => repoShape(ctx, r)), linkFor(ctx, '/api/v3/user/repos', req.query, next));
});

route('GET', '/api/v3/repos/:owner/:repo', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  return reply(200, repoShape(ctx, repo));
});

route('PATCH', '/api/v3/repos/:owner/:repo', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const body = isObject(req.body) ? req.body : {};
  if (typeof body.description === 'string') repo.description = body.description;
  return reply(200, repoShape(ctx, repo));
});

route('DELETE', '/api/v3/repos/:owner/:repo', (ctx, req) => {
  const ok = ctx.store.deleteRepo(req.params.owner as string, req.params.repo as string);
  if (!ok) err(404, 'Not Found');
  return { status: 204, body: null };
});

route('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const body = isObject(req.body) ? req.body : {};
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (!ref.startsWith('refs/') || sha === '') err(422, 'ref and sha are required');
  if (repo.objects.get(sha) === undefined) err(422, 'object does not exist');
  if (repo.refs.has(ref)) err(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  return reply(201, { ref, object: { sha, type: 'commit' } });
});

route('GET', '/api/v3/repos/:owner/:repo/branches', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const out: Record<string, unknown>[] = [];
  for (const [ref, sha] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  return reply(200, out);
});

route('GET', '/api/v3/repos/:owner/:repo/commits', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const tip = ctx.store.resolveRef(repo, ref);
  if (tip === '') return reply(200, []);
  const out: Record<string, unknown>[] = [];
  for (const id of ctx.store.firstParentHistory(repo, tip)) {
    const obj = repo.objects.get(id);
    if (obj === undefined) continue;
    const info = parseCommit(obj.data);
    out.push({
      sha: id,
      commit: {
        message: info.message,
        author: { name: 'ada iversen', email: VIEWER_EMAIL, date: ctx.store.clock.iso(1_735_689_600) },
        committer: { name: 'ada iversen', email: VIEWER_EMAIL, date: ctx.store.clock.iso(1_735_689_600) },
        tree: { sha: info.tree },
      },
      parents: info.parents.map((p) => ({ sha: p })),
    });
  }
  return reply(200, out);
});

route('PUT', '/api/v3/repos/:owner/:repo/contents/:path', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const body = isObject(req.body) ? req.body : {};
  const path = decodeURIComponent(req.params.path as string);
  const branch = asString(body.branch, repo.defaultBranch);
  const contentB64 = asString(body.content);
  if (contentB64 === '') err(422, 'content is required');
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const ref = `refs/heads/${branch}`;
  const tip = ctx.store.refTip(repo, ref);
  const tree = tipTree(ctx, repo, tip);
  const existing = tree === null ? undefined : ctx.store.treePaths(repo, tree).get(path);
  const isUpdate = existing !== undefined;
  if (isUpdate) {
    const sha = asString(body.sha);
    if (sha !== '' && sha.toLowerCase() !== existing.id.toLowerCase()) err(409, 'sha does not match the current blob');
  }
  const blobId = repo.objects.put('blob', data);
  const commitId = commitFile(ctx, repo, branch, path, blobId, messageOf(body));
  return reply(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: blobId, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitId },
  });
});

route('GET', '/api/v3/repos/:owner/:repo/contents/:path', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const path = decodeURIComponent(req.params.path as string);
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  const tip = ctx.store.resolveRef(repo, ref);
  const tree = tipTree(ctx, repo, tip);
  if (tree === null) err(404, 'Not Found');
  const paths = ctx.store.treePaths(repo, tree);
  const file = paths.get(path);
  if (file !== undefined) {
    const data = repo.objects.get(file.id)?.data ?? Buffer.alloc(0);
    return reply(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop(),
      path,
      content: data.toString('base64'),
      sha: file.id,
    });
  }
  // Directory listing: entries directly under `path/`, with real object ids.
  const entries: Record<string, unknown>[] = [];
  const dirEntries = listDir(repo, tree, path);
  if (dirEntries === undefined) err(404, 'Not Found');
  for (const e of dirEntries as { type: string; name: string; path: string; sha: string }[]) {
    entries.push({ type: e.type, name: e.name, path: e.path, sha: e.sha });
  }
  if (entries.length === 0) err(404, 'Not Found');
  return reply(200, entries);
});

/** Immediate children of `dir` in the tree rooted at `treeId` (undefined when no such dir). */
function listDir(repo: Repo, treeId: string, dir: string): { type: string; name: string; path: string; sha: string }[] | undefined {
  const parts = dir === '' ? [] : dir.split('/');
  let cur = treeId;
  for (const part of parts) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const next = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (next === undefined) return undefined;
    cur = next.id;
  }
  const obj = repo.objects.get(cur);
  if (obj === undefined || obj.type !== 'tree') return undefined;
  return parseTree(obj.data).map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: dir === '' ? e.name : `${dir}/${e.name}`,
    sha: e.id,
  }));
}

route('DELETE', '/api/v3/repos/:owner/:repo/contents/:path', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const body = isObject(req.body) ? req.body : {};
  const path = decodeURIComponent(req.params.path as string);
  const branch = asString(body.branch, repo.defaultBranch);
  const tip = ctx.store.refTip(repo, `refs/heads/${branch}`);
  const tree = tipTree(ctx, repo, tip);
  const existing = tree === null ? undefined : ctx.store.treePaths(repo, tree).get(path);
  if (existing === undefined) err(404, 'Not Found');
  const commitId = commitFile(ctx, repo, branch, path, null, messageOf(body));
  return reply(200, { commit: { sha: commitId } });
});

route('POST', '/api/v3/repos/:owner/:repo/labels', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const body = isObject(req.body) ? req.body : {};
  const name = asString(body.name);
  if (name === '') err(422, 'name is required');
  const label = { name, color: asString(body.color, 'ededed') };
  repo.labels.set(name, label);
  return reply(201, label);
});

route('GET', '/api/v3/repos/:owner/:repo/labels', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  return reply(200, [...repo.labels.values()]);
});

route('POST', '/api/v3/repos/:owner/:repo/issues', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const body = isObject(req.body) ? req.body : {};
  const title = asString(body.title);
  if (title === '') err(422, 'title is required');
  const labelNames: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : asString((l as Record<string, unknown>).name))) : [];
  const labels: { name: string; color: string }[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) err(422, `label does not exist: ${name}`);
    labels.push(label);
  }
  const sec = ctx.store.clock.tick();
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body: asString(body.body),
    state: 'open',
    labels,
    comments: [],
    seq: repo.nextIssue,
    createdSec: sec,
    updatedSec: sec,
  };
  repo.issues.push(issue);
  return reply(201, issueShape(ctx, repo, issue));
});

route('GET', '/api/v3/repos/:owner/:repo/issues', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const state = req.query.get('state') ?? 'open';
  let list = repo.issues.filter((i) => state === 'all' || i.state === state);
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  if (sort === 'created') {
    list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, next } = paginate(list, req.query);
  return reply(200, page.map((i) => issueShape(ctx, repo, i)), linkFor(ctx, `/api/v3/repos/${req.params.owner}/${req.params.repo}/issues`, req.query, next));
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const issue = repo.issues.find((i) => i.number === Number(req.params.number));
  if (issue === undefined) err(404, 'Not Found');
  return reply(200, issueShape(ctx, repo, issue as Issue));
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const issue = repo.issues.find((i) => i.number === Number(req.params.number));
  if (issue === undefined) err(404, 'Not Found');
  const body = isObject(req.body) ? req.body : {};
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) (issue as Issue).state = body.state;
  if (typeof body.title === 'string') (issue as Issue).title = body.title;
  if (typeof body.body === 'string') (issue as Issue).body = body.body;
  (issue as Issue).updatedSec = ctx.store.clock.tick();
  return reply(200, issueShape(ctx, repo, issue as Issue));
});

route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const issue = repo.issues.find((i) => i.number === Number(req.params.number));
  if (issue === undefined) err(404, 'Not Found');
  const body = isObject(req.body) ? req.body : {};
  const text = asString(body.body);
  if (text === '') err(422, 'body is required');
  const id = repo.nextComment++;
  (issue as Issue).comments.push({ id, body: text, seq: id });
  return reply(201, { id, body: text, user: userShape(VIEWER_LOGIN) });
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const issue = repo.issues.find((i) => i.number === Number(req.params.number));
  if (issue === undefined) err(404, 'Not Found');
  return reply(200, (issue as Issue).comments.map((c) => ({ id: c.id, body: c.body, user: userShape(VIEWER_LOGIN) })));
});

route('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const body = isObject(req.body) ? req.body : {};
  const headRef = asString(body.head);
  const baseRef = asString(body.base, repo.defaultBranch);
  const title = asString(body.title);
  if (headRef === '' || title === '') err(422, 'head and title are required');
  const headSha = ctx.store.resolveRef(repo, headRef);
  const baseSha = ctx.store.resolveRef(repo, baseRef);
  if (headSha === '' || baseSha === '') err(422, 'head or base branch does not exist');
  const sec = ctx.store.clock.tick();
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body: asString(body.body),
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
  return reply(201, pullShape(ctx, repo, pull));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const state = req.query.get('state') ?? 'open';
  const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
  const { page, next } = paginate(list, req.query);
  return reply(200, page.map((p) => pullShape(ctx, repo, p)), linkFor(ctx, `/api/v3/repos/${req.params.owner}/${req.params.repo}/pulls`, req.query, next));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const pull = repo.pulls.find((p) => p.number === Number(req.params.number));
  if (pull === undefined) err(404, 'Not Found');
  return reply(200, pullShape(ctx, repo, pull as Pull));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const pull = repo.pulls.find((p) => p.number === Number(req.params.number));
  if (pull === undefined) err(404, 'Not Found');
  const p = pull as Pull;
  const base = mergeBase(ctx, repo, p.headSha, p.baseSha);
  const baseTree = base === '' ? null : tipTree(ctx, repo, base);
  const headTree = tipTree(ctx, repo, p.headSha);
  const files = diffTrees(ctx, repo, baseTree, headTree);
  return reply(200, files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
});

/**
 * Squash-merge a pull request (the shared merge used by both REST PUT /merge and the
 * GraphQL mergePullRequest mutation): three-way merge of head into the base tip, one
 * merge commit on the base branch, PR closed + merged. Throws ApiError (404/405).
 * Every merge is a squash merge here: one commit, whatever method was requested.
 */
export function mergePull(ctx: Ctx, repo: Repo, p: Pull): { mergeId: string; message: string } {
  if (p.state === 'closed') err(405, 'Pull request is already closed');
  const baseTip = ctx.store.refTip(repo, `refs/heads/${p.baseRef}`);
  const headTip = ctx.store.refTip(repo, `refs/heads/${p.headRef}`);
  if (baseTip === '' || headTip === '') err(404, 'Not Found');
  const base = mergeBase(ctx, repo, headTip, baseTip);
  const baseTree = base === '' ? null : tipTree(ctx, repo, base);
  const baseTipTree = tipTree(ctx, repo, baseTip);
  const headTree = tipTree(ctx, repo, headTip);
  // Three-way merge: for each path, base-tip wins when head did not change it from the
  // merge-base; head wins when base-tip did not change it; both changed differently = conflict.
  const baseMap = baseTree === null ? new Map() : ctx.store.treePaths(repo, baseTree);
  const tipMap = baseTipTree === null ? new Map() : ctx.store.treePaths(repo, baseTipTree);
  const headMap = headTree === null ? new Map() : ctx.store.treePaths(repo, headTree);
  const merged = new Map(tipMap);
  const allPaths = new Set([...baseMap.keys(), ...tipMap.keys(), ...headMap.keys()]);
  for (const path of allPaths) {
    const b = baseMap.get(path)?.id;
    const t = tipMap.get(path)?.id;
    const h = headMap.get(path)?.id;
    if (h === b) {
      // Head did not change it: keep the base tip's version (already in `merged`).
      continue;
    }
    if (t === b) {
      // Base tip did not change it: take head's version.
      if (h === undefined) merged.delete(path);
      else merged.set(path, headMap.get(path) as { id: string; mode: string });
      continue;
    }
    if (t === h) continue; // Same change on both sides.
    err(405, `Merge conflict on ${path}`);
  }
  // Rebuild the merged tree from the flat map.
  const byDir = new Map<string, { name: string; id: string; mode: string }[]>();
  const putInto = (path: string, id: string, mode: string): void => {
    const parts = path.split('/');
    const name = parts.pop() as string;
    const dir = parts.join('/');
    const list = byDir.get(dir) ?? [];
    list.push({ name, id, mode });
    byDir.set(dir, list);
  };
  for (const [path, v] of merged) putInto(path, v.id, v.mode);
  const buildDir = (dir: string): string => {
    const entries: { mode: string; name: string; id: string }[] = [];
    for (const f of byDir.get(dir) ?? []) entries.push({ mode: f.mode, name: f.name, id: f.id });
    for (const [d] of byDir) {
      if (d.startsWith(dir === '' ? '' : `${dir}/`) && d !== dir) {
        const rest = dir === '' ? d : d.slice(dir.length + 1);
        if (!rest.includes('/')) entries.push({ mode: '40000', name: rest, id: buildDir(d) });
      }
    }
    return repo.objects.put('tree', serializeTree(treeSort(entries)));
  };
  const treeId = buildDir('');
  const sec = ctx.store.clock.tick();
  const message = `Merge pull request #${p.number} from ${VIEWER_LOGIN}/${p.headRef}`;
  const { id: mergeId } = ctx.store.makeCommit(repo, treeId, [baseTip], message);
  repo.refs.set(`refs/heads/${p.baseRef}`, mergeId);
  p.state = 'closed';
  p.merged = true;
  p.mergedAt = ctx.store.clock.iso(sec);
  p.mergeCommitSha = mergeId;
  p.updatedSec = sec;
  return { mergeId, message };
}

/** Whether a pull request can merge cleanly right now ('MERGEABLE' / 'CONFLICTING' / 'UNKNOWN'). */
export function prMergeable(ctx: Ctx, repo: Repo, p: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (p.state !== 'open') return 'UNKNOWN';
  const baseTip = ctx.store.refTip(repo, `refs/heads/${p.baseRef}`);
  const headTip = ctx.store.refTip(repo, `refs/heads/${p.headRef}`);
  if (baseTip === '' || headTip === '') return 'UNKNOWN';
  const base = mergeBase(ctx, repo, headTip, baseTip);
  const baseTree = base === '' ? null : tipTree(ctx, repo, base);
  const baseTipTree = tipTree(ctx, repo, baseTip);
  const headTree = tipTree(ctx, repo, headTip);
  const baseMap = baseTree === null ? new Map() : ctx.store.treePaths(repo, baseTree);
  const tipMap = baseTipTree === null ? new Map() : ctx.store.treePaths(repo, baseTipTree);
  const headMap = headTree === null ? new Map() : ctx.store.treePaths(repo, headTree);
  for (const path of new Set([...baseMap.keys(), ...tipMap.keys(), ...headMap.keys()])) {
    const b = baseMap.get(path)?.id;
    const t = tipMap.get(path)?.id;
    const h = headMap.get(path)?.id;
    if (h === b || t === b || t === h) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, req) => {
  const repo = requireRepo(ctx, req.params.owner as string, req.params.repo as string);
  const pull = repo.pulls.find((p) => p.number === Number(req.params.number));
  if (pull === undefined) err(404, 'Not Found');
  const { mergeId, message } = mergePull(ctx, repo, pull as Pull);
  return reply(200, { merged: true, sha: mergeId, message });
});
