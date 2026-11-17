// Git smart HTTP: info/refs advertisements, upload-pack v2 (ls-refs, fetch) and
// receive-pack v0 (push). All object handling goes through git-core; all state
// lives in the shared Store, so REST and git see the same repos.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  buildPack,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
  pktLine,
  reachable,
  sidebandFrame,
} from './git-core.ts';
import type { Ctx } from './rest.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'forge/1.0';

type Packet = { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer };

/** Strict pkt-line stream parse: stops at the first flush and returns the rest. */
function parsePktStream(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`malformed pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      return { packets, rest: buf.subarray(pos) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  if (pos !== buf.length) throw new Error('trailing bytes in pkt-line stream');
  return { packets, rest: Buffer.alloc(0) };
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

function repoFromPath(ctx: Ctx, path: string): Repo | null {
  const m = /^\/([^/]+)\/([^/]+)\.git(?:\/.*)?$/.exec(path);
  if (m === null) return null;
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  if (owner !== 'adaiversen') return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

/** All refs in advertisement order: HEAD first, then heads, then tags. */
function listRefs(repo: Repo): { name: string; oid: string }[] {
  const names = [...repo.refs.keys()].sort();
  const out: { name: string; oid: string }[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO;
  out.push({ name: 'HEAD', oid: headOid });
  for (const name of names) out.push({ name, oid: repo.refs.get(name) as string });
  return out;
}

/** Peel a tag object to its commit (through nested tags); a commit returns itself. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The peeled target of an annotated tag ref (undefined for lightweight refs). */
function peeledTarget(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return peelToCommit(repo, parseTag(obj.data).object);
}

// ---------------------------------------------------------------- advertisements

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-receive-pack') {
    // Real git's receive-pack advertisement carries no HEAD line and no symref.
    return `report-status delete-refs side-band-64k ofs-delta object-format=sha1 agent=${AGENT}`;
  }
  return `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack object-format=sha1 agent=${AGENT}`;
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo).filter((r) => r.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else if (service === 'git-receive-pack') {
    // No HEAD line here: the first ref carries the capabilities.
    refs.forEach((ref, i) => {
      parts.push(pktLine(i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    });
  } else {
    const head = listRefs(repo)[0] as { name: string; oid: string };
    parts.push(pktLine(`${head.oid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledTarget(repo, ref.oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(repo: Repo, packets: Packet[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue; // command=ls-refs, agent=, object-format= (ignored)
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (headOid === undefined) {
    // Unborn HEAD: only when the client asked for it.
    if (unborn && keep('HEAD')) {
      const extra = symrefs ? ' symref-target:refs/heads/main' : '';
      lines.push(pktLine(`unborn HEAD${extra}\n`));
    }
  } else if (keep('HEAD')) {
    const extra = symrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(pktLine(`${headOid} HEAD${extra}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let extra = '';
    if (peel) {
      const peeled = peeledTarget(repo, oid);
      if (peeled !== undefined) extra += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${oid} ${name}${extra}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(packets: Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue; // command=fetch, agent=, object-format=
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: no action needed.
  }
  return args;
}

/**
 * Objects reachable from `roots` without crossing the parent edge of a shallow
 * boundary commit: a shallow clone holds a boundary commit and its tree, but
 * not the boundary's parents. This is what the client's `haves` actually mean.
 */
function shallowClosure(repo: Repo, roots: string[], boundaries: Set<string>): Set<string> {
  const out = new Set<string>();
  const visitTree = (treeId: string): void => {
    const obj = repo.objects.get(treeId);
    if (obj === undefined || obj.type !== 'tree' || out.has(treeId)) return;
    out.add(treeId);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') visitTree(entry.id);
      else out.add(entry.id);
    }
  };
  const visitCommit = (oid: string): void => {
    if (out.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return;
    out.add(oid);
    visitTree(parseCommit(obj.data).tree);
    if (boundaries.has(oid)) return; // shallow boundary: parents not held
    for (const parent of parseCommit(obj.data).parents) visitCommit(parent);
  };
  for (const root of roots) {
    const obj = repo.objects.get(root);
    if (obj === undefined) continue;
    if (obj.type === 'commit') visitCommit(root);
    else if (obj.type === 'tag') {
      out.add(root);
      const target = peelToCommit(repo, root);
      if (target !== undefined) visitCommit(target);
    } else if (obj.type === 'tree') visitTree(root);
    else out.add(root);
  }
  return out;
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  send: string[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

/**
 * The fetch set: commits reachable from the wants within `depth` generations,
 * their full tree closure, minus everything reachable from the haves.
 * `shallow` names the boundary commits (depth cut); `unshallow` names the
 * client's old boundaries that are now fully included.
 */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const boundarySet = new Set(args.shallow);
  const haveObjects = shallowClosure(repo, args.haves, boundarySet);
  // Full-history commit ancestors of the wants (for ACK decisions).
  const fullAncestors = new Set<string>();
  {
    const queue: string[] = [];
    for (const want of args.wants) {
      const commit = peelToCommit(repo, want);
      if (commit !== undefined) queue.push(commit);
    }
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (fullAncestors.has(oid)) continue;
      fullAncestors.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  // Depth-limited commit walk.
  const commitDist = new Map<string, number>();
  const boundary = new Set<string>();
  const queue: { oid: string; dist: number }[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== undefined) queue.push({ oid: commit, dist: 0 });
  }
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (commitDist.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    commitDist.set(oid, dist);
    if (args.depth !== undefined && dist >= args.depth - 1) {
      if (parseCommit(obj.data).parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  // Object closure of the included commits (trees/blobs fully, parents only when included).
  const sendSet = new Set<string>();
  const visitTree = (treeId: string): void => {
    const obj = repo.objects.get(treeId);
    if (obj === undefined || obj.type !== 'tree' || sendSet.has(treeId)) return;
    sendSet.add(treeId);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') visitTree(entry.id);
      else sendSet.add(entry.id);
    }
  };
  for (const want of args.wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type === 'tag') sendSet.add(want);
  }
  for (const oid of commitDist.keys()) {
    sendSet.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    visitTree(parseCommit(obj.data).tree);
  }
  for (const oid of haveObjects) sendSet.delete(oid);
  const unshallow = args.shallow.filter((oid) => commitDist.has(oid));
  const ack = args.haves.length > 0 && args.haves.every((h) => fullAncestors.has(h) || args.wants.includes(h))
    ? (args.haves[0] as string)
    : null;
  return {
    send: [...sendSet],
    shallow: [...boundary],
    unshallow,
    ack,
  };
}

/** Chunk pack bytes into sideband band-1 pkt-lines (each pkt-line ≤ 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX_DATA = 65520 - 4 - 1; // pkt-line header + band byte
  for (let pos = 0; pos < pack.length; pos += MAX_DATA) {
    out.push(sidebandFrame(1, pack.subarray(pos, Math.min(pos + MAX_DATA, pack.length))));
  }
  return out;
}

function handleFetchV2(repo: Repo, packets: Packet[]): Buffer {
  const args = parseFetchArgs(packets);
  const plan = planFetch(repo, args);
  const pack = buildPack(repo.objects, plan.send);
  const parts: Buffer[] = [];
  // Sections appear only when they apply: real upload-pack sends no
  // acknowledgments section when the request carried no haves, and no
  // shallow-info section when neither depth nor a shallow boundary is in play.
  // (git's client dies with "expected 'packfile', received ..." otherwise.)
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.ack !== null) {
      parts.push(pktLine(`ACK ${plan.ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  const shallowInfo = args.depth !== undefined || args.shallow.length > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0;
  if (shallowInfo) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const frame of sidebandPack(pack)) parts.push(frame);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, packets: Packet[]): Buffer {
  // v0 request: want lines, shallow/deepen lines, flush, have lines, done, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  const plan = planFetch(repo, args);
  const pack = buildPack(repo.objects, plan.send);
  const parts: Buffer[] = [];
  if (plan.ack !== null) {
    parts.push(pktLine(`ACK ${plan.ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const frame of sidebandPack(pack)) parts.push(frame);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer; sideband: boolean } {
  const { packets, rest } = parsePktStream(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    if (nul >= 0) {
      const caps = text.slice(nul + 1).replace(/\n$/, '').split(' ');
      sideband = caps.includes('side-band-64k');
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m === null) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  if (commands.length === 0) throw new Error('no receive-pack commands');
  return { commands, pack: rest, sideband };
}

/** True when `descendant` is `ancestor` or descends from it (all parents walked). */
function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const start = peelToCommit(repo, descendant);
  if (start === undefined) return false;
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  let commands: PushCommand[];
  let pack: Buffer;
  let sideband: boolean;
  try {
    ({ commands, pack, sideband } = parsePushBody(body));
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'bad request';
    return reportBuffer([{ ok: false, ref: '', reason: detail }], false, `unpack ${detail}\n`);
  }
  // Unpack: add the pack's objects to the store, then verify every new tip's
  // closure is complete. A bad pack fails unpack and updates nothing.
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const objects = parsePack(pack);
      for (const obj of objects) repo.objects.putObject(obj.id, obj.type, obj.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const updates = commands.some((c) => c.newOid !== ZERO);
  if (unpackError === null && updates && pack.length === 0) unpackError = 'unpacker error';
  if (unpackError === null) {
    for (const cmd of commands) {
      if (cmd.newOid === ZERO) continue;
      const obj = repo.objects.get(cmd.newOid);
      if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) {
        unpackError = `object ${cmd.newOid} not found`;
        break;
      }
      try {
        reachable(repo.objects, [cmd.newOid]);
      } catch {
        unpackError = `object ${cmd.newOid} has a missing closure`;
        break;
      }
    }
  }
  const results: { ok: boolean; ref: string; reason: string }[] = [];
  if (unpackError !== null) {
    for (const cmd of commands) results.push({ ok: false, ref: cmd.ref, reason: 'unpack failed' });
    return reportBuffer(results, sideband, `unpack ${unpackError}\n`);
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO) {
      // Delete.
      if (current === undefined) results.push({ ok: false, ref: cmd.ref, reason: 'reference does not exist' });
      else if (cmd.oldOid !== current) results.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
      else {
        repo.refs.delete(cmd.ref);
        results.push({ ok: true, ref: cmd.ref, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid === ZERO) {
      // Create.
      if (current !== undefined) results.push({ ok: false, ref: cmd.ref, reason: 'already exists' });
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ok: true, ref: cmd.ref, reason: '' });
      }
      continue;
    }
    // Update.
    if (current === undefined) results.push({ ok: false, ref: cmd.ref, reason: 'reference does not exist' });
    else if (cmd.oldOid !== current) results.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
    else if (!isDescendant(repo, cmd.newOid, cmd.oldOid)) results.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
    else {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ok: true, ref: cmd.ref, reason: '' });
    }
  }
  return reportBuffer(results, sideband, 'unpack ok\n');
}

function reportBuffer(
  results: { ok: boolean; ref: string; reason: string }[],
  sideband: boolean,
  unpackLine: string,
): Buffer {
  const lines: Buffer[] = [pktLine(unpackLine)];
  for (const r of results) {
    if (r.ref === '') continue;
    lines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  lines.push(PKT_FLUSH);
  const report = Buffer.concat(lines);
  if (!sideband) return report;
  // The report-status stream is itself pkt-framed inside band 1.
  const frames: Buffer[] = [];
  const MAX_DATA = 65520 - 4 - 1;
  for (let pos = 0; pos < report.length; pos += MAX_DATA) {
    frames.push(sidebandFrame(1, report.subarray(pos, Math.min(pos + MAX_DATA, report.length))));
  }
  frames.push(PKT_FLUSH);
  return Buffer.concat(frames);
}

// ---------------------------------------------------------------- dispatch

export async function handleGitHttp(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
  baseHeaders: Record<string, string>,
): Promise<boolean> {
  const path = url.pathname;
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (m === null) return false;
  const service = m[3] as string;
  if (service !== 'info/refs' && service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
  const repo = repoFromPath(ctx, path);
  const headers = { ...baseHeaders };
  if (repo === null) {
    sendBuffer(res, 404, Buffer.from('Not Found\n', 'utf8'), { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    return true;
  }
  try {
    if (req.method === 'GET' && service === 'info/refs') {
      const which = url.searchParams.get('service') ?? '';
      if (which === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        if (v2) {
          sendBuffer(res, 200, advertiseV2(), { ...headers, 'content-type': 'application/x-git-upload-pack-advertisement' });
        } else {
          sendBuffer(res, 200, advertiseV0(repo, 'git-upload-pack'), { ...headers, 'content-type': 'application/x-git-upload-pack-advertisement' });
        }
        return true;
      }
      if (which === 'git-receive-pack') {
        sendBuffer(res, 200, advertiseV0(repo, 'git-receive-pack'), { ...headers, 'content-type': 'application/x-git-receive-pack-advertisement' });
        return true;
      }
      sendBuffer(res, 400, Buffer.from('unknown service\n', 'utf8'), { ...headers, 'content-type': 'text/plain; charset=utf-8' });
      return true;
    }
    if (req.method === 'POST' && service === 'git-upload-pack') {
      const { packets } = parsePktStream(rawBody);
      const first = packets.find((p) => p.kind === 'data');
      const firstLine = first !== undefined ? first.payload.toString('utf8').replace(/\n$/, '') : '';
      let body: Buffer;
      if (firstLine === 'command=ls-refs') body = handleLsRefs(repo, packets);
      else if (firstLine === 'command=fetch') body = handleFetchV2(repo, packets);
      else if (firstLine.startsWith('want ')) body = handleFetchV0(repo, packets);
      else {
        sendBuffer(res, 400, Buffer.from('bad request\n', 'utf8'), { ...headers, 'content-type': 'text/plain; charset=utf-8' });
        return true;
      }
      sendBuffer(res, 200, body, { ...headers, 'content-type': 'application/x-git-upload-pack-result' });
      return true;
    }
    if (req.method === 'POST' && service === 'git-receive-pack') {
      const body = handleReceivePack(repo, rawBody);
      sendBuffer(res, 200, body, { ...headers, 'content-type': 'application/x-git-receive-pack-result' });
      return true;
    }
    return false;
  } catch (err) {
    // A malformed git request must never take the server down.
    process.stderr.write(`[forge] git error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) {
      sendBuffer(res, 400, Buffer.from('bad request\n', 'utf8'), { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    }
    return true;
  }
}
