// Git object model: SHA-1 ids, zlib object bytes, packfiles and pkt-lines.
// Pure TypeScript on the Node standard library; no git binary, no outside service.
//
// Objects are stored by their raw bytes so a clone round-trips them byte-exactly:
// the suite pushes a commit and clones it back expecting identical bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

const TYPE_NAMES: Record<number, string> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};

const TYPE_CODES: Record<string, number> = {
  commit: OBJ_COMMIT,
  tree: OBJ_TREE,
  blob: OBJ_BLOB,
  tag: OBJ_TAG,
};

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of raw content of a type: sha1("<type> <len>\0" + content). */
export function objectId(type: string, content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, content]));
}

export interface GitObject {
  type: string;
  data: Buffer;
}

/** In-memory object database: id -> raw object bytes. */
export class ObjectStore {
  private objects = new Map<string, GitObject>();

  has(id: string): boolean {
    return this.objects.has(id);
  }

  get(id: string): GitObject | undefined {
    return this.objects.get(id);
  }

  /** Store raw content of a type; returns its id. */
  put(type: string, data: Buffer): string {
    const id = objectId(type, data);
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
    return id;
  }

  /** Store an already-identified object (e.g. unpacked from a pack). */
  putObject(id: string, type: string, data: Buffer): void {
    if (!this.objects.has(id)) this.objects.set(id, { type, data });
  }

  get size(): number {
    return this.objects.size;
  }

  ids(): IterableIterator<string> {
    return this.objects.keys();
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  id: string;
}

/** Parse a raw tree object into entries (mode, name, 20-byte id). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.subarray(pos, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const id = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, id });
    pos = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (already in git order) to raw tree bytes. */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.id, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort order: entries sort by name, directories as if named "name/". */
export function treeSort(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Raw bytes, kept so the object round-trips exactly. */
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
  raw: Buffer;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message, raw: data };
}

// ---------------------------------------------------------------- reachability

/** All object ids reachable from a set of tip ids (commits/tags), walking parents, trees, blobs. */
export function reachable(store: ObjectStore, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    const obj = store.get(id);
    if (obj === undefined) continue;
    seen.add(id);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const p of commit.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.id);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object !== '') stack.push(tag.object);
    }
  }
  return seen;
}

// ---------------------------------------------------------------- packfiles

function encodePackObjectHeader(type: number, size: number): Buffer {
  // varint: low 4 bits in the first byte with the type in bits 4..6, then 7 bits per byte.
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, no deltas) holding the given objects. */
export function buildPack(store: ObjectStore, ids: string[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ids.length, 8);
  chunks.push(header);
  // Incremental trailer hash: the old code Buffer.concat'ed all chunks just to
  // hash them, then concat'ed them again for the return — two full pack copies.
  const hash = createHash('sha1');
  hash.update(header);
  for (const id of ids) {
    const obj = store.get(id);
    if (obj === undefined) continue;
    const code = TYPE_CODES[obj.type];
    if (code === undefined) continue;
    const objHeader = encodePackObjectHeader(code, obj.data.length);
    const deflated = deflateSync(obj.data, { level: 6 });
    chunks.push(objHeader, deflated);
    hash.update(objHeader);
    hash.update(deflated);
  }
  const trailer = Buffer.from(hash.digest('hex'), 'hex');
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

interface DeltaResult {
  type: string;
  data: Buffer;
}

function readVarint(data: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = pos;
  for (;;) {
    const byte = data[next] as number;
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next };
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  if (src.value !== base.length) throw new Error(`delta base size ${src.value} != ${base.length}`);
  const outSize = readVarint(delta, pos);
  pos = outSize.next;
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      // copy from base: offset/size bits select bytes of the op.
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (produced !== outSize.value) throw new Error(`delta produced ${produced} bytes, expected ${outSize.value}`);
  return Buffer.concat(parts);
}

export interface UnpackedObject {
  id: string;
  type: string;
  data: Buffer;
}

/**
 * Inflate one zlib stream starting at `pos`. inflateSync ignores trailing bytes, and with
 * `info: true` the engine reports exactly how many input bytes the stream consumed, so one
 * call both inflates and finds the stream end — no binary search, no failed probes (each
 * failed probe used to build a stack-trace Error, ~18% of push CPU).
 */
export function inflateOne(pack: Buffer, pos: number): { data: Buffer; next: number } {
  const { buffer, engine } = inflateSync(pack.subarray(pos), { info: true });
  return { data: buffer, next: pos + engine.bytesWritten };
}

/** Parse a packfile into objects, resolving OFS_DELTA and REF_DELTA against earlier entries. */
export function parsePack(pack: Buffer): UnpackedObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const results: UnpackedObject[] = [];
  const byOffset = new Map<number, UnpackedObject>();
  const byId = new Map<string, UnpackedObject>();
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const entryStart = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseObj: UnpackedObject | undefined;
    if (type === OBJ_OFS_DELTA) {
      let b = pack[pos] as number;
      pos += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseObj = byOffset.get(entryStart - offset);
      if (baseObj === undefined) throw new Error('ofs-delta base not found');
    } else if (type === OBJ_REF_DELTA) {
      const baseId = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      baseObj = byId.get(baseId);
      if (baseObj === undefined) throw new Error('ref-delta base not found');
    }
    const inflated = inflateOne(pack, pos);
    pos = inflated.next;
    let obj: UnpackedObject;
    if (type === OBJ_OFS_DELTA || type === OBJ_REF_DELTA) {
      const data = applyDelta((baseObj as UnpackedObject).data, inflated.data);
      obj = { id: objectId((baseObj as UnpackedObject).type, data), type: (baseObj as UnpackedObject).type, data };
    } else {
      const typeName = TYPE_NAMES[type];
      if (typeName === undefined) throw new Error(`unknown pack object type ${type}`);
      if (inflated.data.length !== size) throw new Error(`object size mismatch: header ${size}, inflated ${inflated.data.length}`);
      obj = { id: objectId(typeName, inflated.data), type: typeName, data: inflated.data };
    }
    results.push(obj);
    byOffset.set(entryStart, obj);
    byId.set(obj.id, obj);
  }
  return results;
}

// ---------------------------------------------------------------- pkt-lines

/** Encode a payload as one pkt-line (4 hex digits length including the header). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** The pkt-line flush packet. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');

/** The pkt-line delimiter packet (protocol v2). */
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** The pkt-line response-end packet (protocol v2). */
export const PKT_END = Buffer.from('0002', 'ascii');

/** Split a buffer of pkt-lines into payloads; 'flush'/'delim'/'end' markers become null entries. */
export function parsePktLines(buf: Buffer): (Buffer | null)[] {
  const out: (Buffer | null)[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (len === 0) {
      out.push(null);
      pos += 4;
      continue;
    }
    if (len === 1 || len === 2) {
      out.push(null);
      pos += 4;
      continue;
    }
    out.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return out;
}

/** Encode a sideband frame: channel 1 = data, 2 = progress, 3 = error. */
export function sidebandFrame(channel: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([channel]), data]));
}
