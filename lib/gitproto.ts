// Git smart HTTP: info/refs advertisements (v0 and v2), ls-refs, fetch (v0 and v2, with shallow
// and deepen), and receive-pack pushes with report-status. Implemented from the protocol itself;
// the object math lives in gitcore.ts.

import { Forge, VIEWER, type Repo } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  commitAncestors,
  depthLimitedObjects,
  isAncestor,
  parseTag,
  peelToCommit,
  readPackInto,
  writePack,
} from './gitcore.ts';
import { json, notFound, type HttpResult } from './rest.ts';

const AGENT = 'bailout-forge/1.0';

// ---------------------------------------------------------------- pkt-line

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a request body into pkt-line payloads up to the first flush; returns the rest raw. */
function splitPktLines(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) return { lines, rest: body.subarray(offset + 4) };
    if (length === 1 || length === 2) {
      lines.push(length === 1 ? '\x01' : '\x02');
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('bad pkt-line length');
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

/** Parse a whole pkt-line request into sections split by delim/flush markers. */
function parsePktSections(body: Buffer): { sections: string[][]; rest: Buffer } {
  const sections: string[][] = [[]];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) return { sections, rest: body.subarray(offset + 4) };
    if (length === 1) {
      sections.push([]);
      offset += 4;
      continue;
    }
    if (length === 2) return { sections, rest: body.subarray(offset + 4) };
    if (length < 4 || offset + length > body.length) throw new Error('bad pkt-line length');
    sections[sections.length - 1].push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { sections, rest: body.subarray(offset) };
}

function stripNl(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0][1];
    parts.push(pkt(`${headSha} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pkt(`${oid} ${ref}\n`));
      const object = forge.store.get(oid);
      if (object?.type === 'tag') {
        parts.push(pkt(`${peelToCommit(forge.store, oid)} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pkt('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

export function infoRefs(forge: Forge, repo: Repo, service: string, gitProtocol: string | undefined): HttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  const isV2 = service === 'git-upload-pack' && (gitProtocol ?? '').includes('version=2');
  const body = isV2 ? v2Advertisement() : v0Advertisement(forge, repo, service);
  return {
    status: 200,
    rawBody: body,
    contentType: `application/x-${service}-advertisement`,
  };
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(forge: Forge, repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (headSha) lines.push(`${headSha} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`);
    else if (wantUnborn) lines.push(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const object = forge.store.get(oid);
      if (object?.type === 'tag') line += ` peeled:${peelToCommit(forge.store, oid)}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pkt(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of lines) {
    const line = stripNl(raw);
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface FetchPlan {
  send: Set<string>;
  shallowInfo: string[];
  unshallow: string[];
  commonHaves: string[];
}

function planFetch(forge: Forge, args: FetchArgs): FetchPlan {
  const store = forge.store;
  const wants = args.wants.filter((oid) => store.has(oid));
  const commonHaves: string[] = [];
  if (args.haves.length) {
    const wantAncestors = new Set<string>();
    for (const want of wants) {
      for (const ancestor of commitAncestors(store, want)) wantAncestors.add(ancestor);
    }
    for (const have of args.haves) {
      if (wantAncestors.has(have) || wants.includes(have)) commonHaves.push(have);
    }
  }

  if (args.depth !== null && args.depth > 0) {
    const { objects, boundary } = depthLimitedObjects(store, wants, args.depth);
    const send = new Set(objects);
    // Deepen: the client already holds its shallow boundary commits and their trees.
    for (const boundaryOid of args.shallow) {
      send.delete(boundaryOid);
      const commit = store.get(boundaryOid);
      if (commit?.type === 'commit') {
        const { tree } = ((): { tree: string } => {
          const text = commit.data.toString('utf8');
          const match = /^tree ([0-9a-f]{40})$/m.exec(text);
          return { tree: match ? match[1] : '' };
        })();
        if (tree) {
          for (const oid of collectReachable(store, [tree])) send.delete(oid);
        }
      }
    }
    const unshallow = args.shallow.filter((oid) => objects.has(oid) && !boundary.has(oid));
    return { send, shallowInfo: [...boundary], unshallow, commonHaves };
  }

  const wanted = collectReachable(store, wants);
  const haveClosure = args.haves.length ? collectReachable(store, args.haves.filter((oid) => store.has(oid))) : new Set<string>();
  const send = new Set<string>();
  for (const oid of wanted) {
    if (!haveClosure.has(oid)) send.add(oid);
  }
  return { send, shallowInfo: [], unshallow: [], commonHaves };
}

function cachedPack(forge: Forge, args: FetchArgs, send: Set<string>): Buffer {
  const key = `${args.wants.join(',')}|${args.depth ?? ''}|${args.haves.join(',')}|${args.shallow.join(',')}`;
  const cached = forge.packCache.get(key);
  if (cached) return cached;
  const pack = writePack(forge.store, send);
  if (forge.packCache.size < 64) forge.packCache.set(key, pack);
  return pack;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function fetchV2(forge: Forge, args: FetchArgs): Buffer {
  const plan = planFetch(forge, args);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pkt('acknowledgments\n'));
  if (args.haves.length === 0 || plan.commonHaves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    for (const oid of plan.commonHaves) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (plan.shallowInfo.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallowInfo) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.send.size > 0) {
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(cachedPack(forge, args, plan.send)));
    parts.push(PKT_DELIM);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(forge: Forge, args: FetchArgs): Buffer {
  const plan = planFetch(forge, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowInfo) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  if (plan.send.size > 0) {
    parts.push(...sidebandPack(cachedPack(forge, args, plan.send)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(forge: Forge, repo: Repo, body: Buffer): HttpResult {
  try {
    const { sections } = parsePktSections(body);
    const first = sections[0] ?? [];
    const commandLine = first.length ? stripNl(first[0]) : '';
    if (commandLine === 'command=ls-refs') {
      return { status: 200, rawBody: lsRefs(forge, repo, (sections[1] ?? []).map(stripNl)), contentType: 'application/x-git-upload-pack-result' };
    }
    if (commandLine === 'command=fetch') {
      const args = parseFetchArgs((sections[1] ?? []).map(stripNl));
      return { status: 200, rawBody: fetchV2(forge, args), contentType: 'application/x-git-upload-pack-result' };
    }
    // v0: wants in section 0, haves in section 1.
    const wantLines = first.map(stripNl);
    const wants: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of wantLines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0].trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    const haves: string[] = [];
    for (const raw of sections[1] ?? []) {
      const line = stripNl(raw);
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    const args: FetchArgs = { wants, haves, shallow, depth, done: true };
    return { status: 200, rawBody: fetchV0(forge, args), contentType: 'application/x-git-upload-pack-result' };
  } catch {
    return json(400, { message: 'Bad request' });
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function receivePack(forge: Forge, repo: Repo, body: Buffer): Promise<HttpResult> {
  try {
    const { lines, rest } = splitPktLines(body);
    const commands: PushCommand[] = [];
    let sideband = false;
    lines.forEach((raw, index) => {
      let line = stripNl(raw);
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const caps = line.slice(nul + 1);
          if (caps.includes('side-band-64k')) sideband = true;
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length === 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    });

    let unpackOk = true;
    let unpackDetail = 'ok';
    if (rest.length > 0) {
      try {
        await readPackInto(forge.store, rest);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'error';
      }
    }

    const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
    for (const command of commands) {
      report.push(`${applyCommand(forge, repo, command, unpackOk)}`);
    }
    const reportBody = Buffer.concat([...report.map((line) => pkt(`${line}\n`)), PKT_FLUSH]);
    let rawBody: Buffer;
    if (sideband) {
      const parts: Buffer[] = [];
      const CHUNK = 32768;
      for (let offset = 0; offset < reportBody.length; offset += CHUNK) {
        parts.push(pkt(Buffer.concat([Buffer.from([1]), reportBody.subarray(offset, offset + CHUNK)])));
      }
      parts.push(PKT_FLUSH);
      rawBody = Buffer.concat(parts);
    } else {
      rawBody = reportBody;
    }
    return { status: 200, rawBody, contentType: 'application/x-git-receive-pack-result' };
  } catch {
    return json(400, { message: 'Bad request' });
  }
}

function applyCommand(forge: Forge, repo: Repo, command: PushCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = command;
  const ng = (reason: string): string => `ng ${ref} ${reason}`;
  if (!unpackOk) return ng('unpacker error');
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return ng('reference not found');
    if (oldOid !== ZERO_OID && oldOid !== current) return ng('stale info');
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  if (!forge.store.has(newOid)) return ng('invalid object');
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined && current !== newOid) return ng('already exists');
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return ng('stale info');
  // Update: must fast-forward when both ends are commits.
  const newCommit = peelToCommit(forge.store, newOid);
  const oldCommit = peelToCommit(forge.store, oldOid);
  if (forge.store.get(newCommit)?.type === 'commit' && forge.store.get(oldCommit)?.type === 'commit') {
    if (!isAncestor(forge.store, oldCommit, newCommit)) return ng('non-fast-forward');
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

export function isGitPath(path: string): { owner: string; repo: string; tail: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!match) return null;
  return { owner: match[1], repo: match[2], tail: match[3] ?? '' };
}

export async function routeGit(
  forge: Forge,
  method: string,
  gitPath: { owner: string; repo: string; tail: string },
  query: URLSearchParams,
  body: Buffer,
  gitProtocol: string | undefined,
): Promise<HttpResult> {
  if (gitPath.owner !== VIEWER.login) return notFound();
  const repo = forge.getRepo(gitPath.repo);
  if (!repo) return notFound();
  if (method === 'GET' && gitPath.tail === '/info/refs') {
    return infoRefs(forge, repo, query.get('service') ?? '', gitProtocol);
  }
  if (method === 'POST' && gitPath.tail === '/git-upload-pack') return uploadPack(forge, repo, body);
  if (method === 'POST' && gitPath.tail === '/git-receive-pack') return receivePack(forge, repo, body);
  return notFound();
}

// Re-exported for app.ts convenience.
export { parseTag };
