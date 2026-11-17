// The forge's in-memory store: users, repositories, git refs/objects, issues, pulls.
//
// Everything is in memory: the trial mounts the repository read-only and only /tmp is
// writable, so the store never touches disk. Determinism: a logical clock ticks once per
// mutation, so two runs on the same input produce the same timestamps, ids and SHAs;
// nothing here reads the wall clock or Math.random.
//
// The shop token (MAKEFUN_SHOP_TOKEN) belongs to the shop's configured account. The
// contest's scenario is fixed public data (wire.ts SCENARIO_SEED, never changed): the
// viewer is adaiversen, the stranger olgabauer. A repository belongs to the login the
// token names, so the same name under another owner is a 404, never a 403.

import { ObjectStore, buildCommit, parseCommit, parseTree, serializeTree, treeSort, type TreeEntry } from './git-core.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const STRANGER_LOGIN = 'olgabauer';

/** Logical clock: starts at the scenario epoch, ticks one second per mutation. */
export class Clock {
  private sec = 1_735_689_600;
  tick(): number {
    this.sec += 1;
    return this.sec;
  }
  iso(sec: number): string {
    return new Date(sec * 1000).toISOString().replace(/\.000Z$/, 'Z');
  }
  /** "Name <email> epoch +0000" for git author/committer lines. */
  ident(sec: number): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${sec} +0000`;
  }
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: { id: number; body: string; seq: number }[];
  seq: number;
  createdSec: number;
  updatedSec: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  seq: number;
  createdSec: number;
  updatedSec: number;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: ObjectStore;
  /** refname -> commit sha; refs/heads/* and refs/tags/*. */
  refs: Map<string, string>;
  /** Annotated tag objects are in `objects`; tag ref -> tag object id (or commit id). */
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

export class Store {
  readonly clock = new Clock();
  private repos = new Map<string, Repo>();
  private counter = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.counter++,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** The tip of a ref, or '' when the ref does not exist (unborn branch). */
  refTip(repo: Repo, ref: string): string {
    return repo.refs.get(ref) ?? '';
  }

  /** Resolve a branch name or ref to a commit sha ('' when unborn/missing). */
  resolveRef(repo: Repo, ref: string): string {
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? '';
    if (ref === 'HEAD') {
      const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
      return head;
    }
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? '';
  }

  /** Flat path -> blob id map for a tree (recursive). */
  treePaths(repo: Repo, treeId: string, prefix = ''): Map<string, { id: string; mode: string }> {
    const out = new Map<string, { id: string; mode: string }>();
    const obj = repo.objects.get(treeId);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [p, v] of this.treePaths(repo, entry.id, path)) out.set(p, v);
      } else {
        out.set(path, { id: entry.id, mode: entry.mode });
      }
    }
    return out;
  }

  /**
   * Return a new root tree id with `path` set to `blobId` (or removed when null),
   * creating intermediate trees as needed. Pure: writes new tree objects.
   */
  updateTree(repo: Repo, rootTreeId: string | null, path: string, blobId: string | null, mode = '100644'): string {
    const parts = path.split('/');
    const build = (treeId: string | null, depth: number): string => {
      const obj = treeId === null ? undefined : repo.objects.get(treeId);
      const entries: TreeEntry[] = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
      const name = parts[depth] as string;
      const last = depth === parts.length - 1;
      const idx = entries.findIndex((e) => e.name === name);
      if (last) {
        if (blobId === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode, name, id: blobId };
        } else {
          entries.push({ mode, name, id: blobId });
        }
      } else {
        const child = idx >= 0 ? entries[idx] : undefined;
        const childTree = child !== undefined && child.mode === '40000' ? child.id : null;
        const next = build(childTree, depth + 1);
        if (idx >= 0) {
          entries[idx] = { mode: '40000', name, id: next };
        } else {
          entries.push({ mode: '40000', name, id: next });
        }
      }
      const sorted = treeSort(entries);
      return repo.objects.put('tree', serializeTree(sorted));
    };
    return build(rootTreeId, 0);
  }

  /** Create a commit object on top of `parentIds` with `treeId`; returns its id. */
  makeCommit(repo: Repo, treeId: string, parentIds: string[], message: string): { id: string; sec: number } {
    const sec = this.clock.tick();
    const raw = buildCommit(treeId, parentIds, this.clock.ident(sec), this.clock.ident(sec), message);
    const id = repo.objects.put('commit', raw);
    return { id, sec };
  }

  /** First-parent history from a tip (newest first), following parents[0]. */
  firstParentHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    let cur = tip;
    const seen = new Set<string>();
    while (cur !== '' && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') break;
      cur = parseCommit(obj.data).parents[0] ?? '';
    }
    return out;
  }

  /** All ancestors of a tip (any parent), for merge-base computation. */
  ancestors(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === '' || seen.has(id)) continue;
      const obj = repo.objects.get(id);
      if (obj === undefined) continue;
      seen.add(id);
      if (obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) stack.push(p);
      } else if (obj.type === 'tag') {
        // Annotated tags point at their target; handled by caller via peel.
      }
    }
    return seen;
  }
}
