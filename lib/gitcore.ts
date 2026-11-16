// Git object model for the forge: SHA-1 objects, trees, commits, packfiles, reachability.
// Standard library only (node:crypto, node:zlib), exactly as git computes them.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** An in-memory object database. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }
  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel an oid through annotated tags to the commit beneath (or the oid itself). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = store.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from the tips (commits walk parents, trees recurse). */
export function collectReachable(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commit-only ancestors of a tip, including the tip (empty when the tip is not a commit). */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [peelToCommit(store, tip)];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  // Walk from the tip and stop the moment the ancestor is reached: a
  // fast-forward check on a sequential push finds its answer one step back,
  // where building the tip's whole ancestor set cost a full history parse
  // on every push. The visited set keeps the walk linear in the worst case.
  const seen = new Set<string>();
  const stack = [peelToCommit(store, tip)];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/**
 * Objects for a depth-limited fetch: commits within `depth` generations of the wants (want commits
 * are generation 0), plus the full trees and blobs of those commits, plus tag objects pointing at
 * them. Returns the object set and the shallow boundary (included commits whose parents were cut).
 */
export function depthLimitedObjects(
  store: ObjectStore,
  wants: readonly string[],
  depth: number,
): { objects: Set<string>; boundary: Set<string> } {
  const commitDepth = new Map<string, number>();
  let frontier = wants.map((want) => peelToCommit(store, want));
  for (const oid of frontier) commitDepth.set(oid, 0);
  for (let generation = 1; generation < depth; generation += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!commitDepth.has(parent)) {
          commitDepth.set(parent, generation);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  const boundary = new Set<string>();
  const objects = new Set<string>();
  for (const [oid] of commitDepth) {
    objects.add(oid);
    const commit = parseCommit(store.get(oid)!.data);
    if (generationOf(commitDepth, oid) === depth - 1) {
      for (const parent of commit.parents) {
        if (store.has(parent)) boundary.add(oid);
      }
    }
    // Full tree closure of this commit.
    const stack = [commit.tree];
    while (stack.length) {
      const treeOid = stack.pop()!;
      if (objects.has(treeOid)) continue;
      const treeObject = store.get(treeOid);
      if (!treeObject) continue;
      objects.add(treeOid);
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  }
  // Tag objects that point at included objects.
  for (const want of wants) {
    if (store.get(want)?.type === 'tag') objects.add(want);
  }
  return { objects, boundary };
}

function generationOf(map: Map<string, number>, oid: string): number {
  return map.get(oid) ?? 0;
}

// ---------------------------------------------------------------- packfiles

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const list = [...oids].filter((oid) => store.has(oid));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of list) {
    const object = store.get(oid)!;
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; type: GitObjectType; next: number } {
  let byte = buffer[start];
  const type = CODE_TYPE[(byte >> 4) & 0x07];
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { size, type, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta size mismatch');
  return out;
}

interface PendingObject {
  type: GitObjectType;
  data: Buffer;
  ofsBase?: number;
  refBase?: string;
}

/**
 * Inflate the one zlib stream that starts at `offset` in a pack, resolving
 * with its bytes and the exact number of compressed bytes it occupied. The
 * stream reports its own bytes read, which replaces the old binary search
 * that re-inflated the object about a dozen times just to find where its
 * stream ended: one inflate per object now, not a search through them.
 */
function inflateStreamAt(pack: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesRead }));
    stream.end(pack.subarray(offset));
  });
}

/** Read a pack into the store; resolves OFS_DELTA and REF_DELTA (bases may be thin, from the store). */
export async function readPackInto(store: ObjectStore, pack: Buffer): Promise<string[]> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const added: string[] = [];
  const pending: PendingObject[] = [];
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    offsets.push(offset);
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (pack[offsets[index]] >> 4) & 0x07;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base object's start.
      let byte = pack[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseIndex = offsets.indexOf(offsets[index] - baseOffset);
      const { data: inflated, consumed } = await inflateStreamAt(pack, offset);
      offset += consumed;
      pending.push({ type: 'blob', data: inflated, ofsBase: baseIndex });
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id follows the header.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: inflated, consumed } = await inflateStreamAt(pack, offset);
      offset += consumed;
      pending.push({ type: 'blob', data: inflated, refBase: baseOid });
    } else {
      const { data: inflated, consumed } = await inflateStreamAt(pack, offset);
      offset += consumed;
      pending.push({ type: header.type, data: inflated });
    }
  }
  // Resolve in passes: plain objects first, then deltas whose bases are known.
  const resolved = new Array<GitObject | null>(count).fill(null);
  for (let index = 0; index < count; index += 1) {
    const entry = pending[index];
    if (entry.ofsBase === undefined && entry.refBase === undefined) resolved[index] = { type: entry.type, data: entry.data };
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (let index = 0; index < count; index += 1) {
      if (resolved[index]) continue;
      const entry = pending[index];
      let base: GitObject | undefined;
      if (entry.ofsBase !== undefined) base = resolved[entry.ofsBase] ?? undefined;
      else if (entry.refBase !== undefined) base = store.get(entry.refBase);
      if (!base) continue;
      resolved[index] = { type: base.type, data: applyDelta(base.data, entry.data) };
      progress = true;
    }
  }
  for (let index = 0; index < count; index += 1) {
    const object = resolved[index];
    if (!object) throw new Error('unresolved delta in pack');
    added.push(store.put(object.type, object.data));
  }
  return added;
}
