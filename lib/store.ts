// The forge's state and domain operations: repositories over one shared object store, plus the
// issue and pull-request records the REST, GraphQL and MCP surfaces all read and write.

import {
  ObjectStore,
  buildCommit,
  buildTree,
  parseCommit,
  parseTree,
  peelToCommit,
  type TreeEntry,
} from './gitcore.ts';

/** The contest scenario's fixed viewer (wire.ts SCENARIO_SEED is a contest constant). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** Trial clock: MAKEFUN_TRIAL_NOW when the harness sets it, else the scenario epoch. */
export const TRIAL_NOW_MS = ((): number => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber * (asNumber < 1e12 ? 1000 : 1);
  }
  return 1_735_689_600_000;
})();

let sequence = 0;
/** A deterministic, strictly increasing timestamp (trial now + a per-process second counter). */
export function nextTimestamp(): { iso: string; epochSec: number } {
  sequence += 1;
  const epochSec = Math.floor(TRIAL_NOW_MS / 1000) + sequence;
  return { iso: new Date(epochSec * 1000).toISOString(), epochSec };
}

export function authorLine(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  databaseId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Pull {
  number: number;
  databaseId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssueNumber: number;
  createdAt: string;
  updatedAt: string;
}

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  /** Fetch pack cache: identical want/depth sets (the clone benchmark's fifty clones) reuse bytes. */
  readonly packCache = new Map<string, Buffer>();
  private nextRepoId = 1;
  private nextDatabaseId = 1;
  private nextCommentId = 1;

  createRepo(name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo | null {
    if (this.repos.has(name)) return null;
    const now = nextTimestamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      createdAt: now.iso,
      updatedAt: now.iso,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  allocDatabaseId(): number {
    return this.nextDatabaseId++;
  }

  allocCommentId(): number {
    return this.nextCommentId++;
  }

  /** The sha a ref points at, resolving HEAD to the default branch. */
  refSha(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }

  /** Flatten a tree (by sha) into path -> {oid, mode}. */
  flattenTree(treeSha: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const object = this.store.get(treeSha);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Build (and store) a tree from a flat path -> {oid, mode} map; returns its sha. */
  buildTreeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.store.put('tree', buildTree(entries));
    };
    return build(root);
  }

  treeOfCommit(commitSha: string): string {
    const object = this.store.get(peelToCommit(this.store, commitSha));
    if (!object || object.type !== 'commit') return '';
    return parseCommit(object.data).tree;
  }

  flatOfCommit(commitSha: string): Map<string, { oid: string; mode: string }> {
    const tree = this.treeOfCommit(commitSha);
    return tree ? this.flattenTree(tree) : new Map();
  }

  /** Commit a set of path updates (null deletes) onto a branch; returns the new commit sha. */
  commitUpdates(
    repo: Repo,
    branch: string,
    updates: Map<string, { oid: string; mode: string } | null>,
    message: string,
  ): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const flat = parent ? this.flatOfCommit(parent) : new Map<string, { oid: string; mode: string }>();
    for (const [path, value] of updates) {
      if (value === null) flat.delete(path);
      else flat.set(path, value);
    }
    const tree = this.buildTreeFromFlat(flat);
    const { epochSec } = nextTimestamp();
    const line = authorLine(epochSec);
    const commit = this.store.put(
      'commit',
      buildCommit({ tree, parents: parent ? [parent] : [], author: line, committer: line, message }),
    );
    repo.refs.set(ref, commit);
    repo.updatedAt = new Date(epochSec * 1000).toISOString();
    return commit;
  }

  /** The merge-base (best common ancestor) of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOf = (tip: string): string[] => {
      const order: string[] = [];
      const seen = new Set<string>();
      const queue = [peelToCommit(this.store, tip)];
      while (queue.length) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        order.push(oid);
        const object = this.store.get(oid);
        if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
      }
      return order;
    };
    const bAncestors = new Set(ancestorsOf(b));
    for (const candidate of ancestorsOf(a)) {
      if (bAncestors.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Three-way tree merge for a squash: returns the merged flat map, or null on conflict
   * (the same path changed differently on both sides since the merge-base, or changed on one
   * side and deleted on the other).
   */
  mergeTrees(
    baseFlat: Map<string, { oid: string; mode: string }>,
    oursFlat: Map<string, { oid: string; mode: string }>,
    theirsFlat: Map<string, { oid: string; mode: string }>,
  ): Map<string, { oid: string; mode: string }> | null {
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
    for (const path of paths) {
      const base = baseFlat.get(path);
      const ours = oursFlat.get(path);
      const theirs = theirsFlat.get(path);
      const oursChanged = !sameEntry(base, ours);
      const theirsChanged = !sameEntry(base, theirs);
      if (oursChanged && theirsChanged) {
        if (!sameEntry(ours, theirs)) return null;
        if (ours) merged.set(path, ours);
      } else if (theirsChanged) {
        if (theirs) merged.set(path, theirs);
      } else if (ours) {
        merged.set(path, ours);
      }
    }
    return merged;
  }

  /** Whether a pull can merge cleanly right now (head into the current base tip). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    if (!baseSha || !headSha) return false;
    const base = this.mergeBase(baseSha, headSha);
    const baseFlat = base ? this.flatOfCommit(base) : new Map<string, { oid: string; mode: string }>();
    return this.mergeTrees(baseFlat, this.flatOfCommit(baseSha), this.flatOfCommit(headSha)) !== null;
  }

  /** Squash-merge a pull onto its base branch; returns the merge commit sha, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseSha = repo.refs.get(baseRef);
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    if (!baseSha || !headSha) return null;
    const base = this.mergeBase(baseSha, headSha);
    const baseFlat = base ? this.flatOfCommit(base) : new Map<string, { oid: string; mode: string }>();
    const merged = this.mergeTrees(baseFlat, this.flatOfCommit(baseSha), this.flatOfCommit(headSha));
    if (merged === null) return null;
    const tree = this.buildTreeFromFlat(merged);
    const { epochSec, iso } = nextTimestamp();
    const line = authorLine(epochSec);
    const commit = this.store.put(
      'commit',
      buildCommit({ tree, parents: [baseSha], author: line, committer: line, message: `${pull.title} (#${pull.number})` }),
    );
    repo.refs.set(baseRef, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso;
    pull.mergeCommitSha = commit;
    pull.updatedAt = iso;
    return commit;
  }
}

function sameEntry(
  a: { oid: string; mode: string } | undefined,
  b: { oid: string; mode: string } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

/** Line counts for a blob pair, for pull-request file stats (LCS over lines; files are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 4_000_000) {
    // Fallback for very large files: everything changed counts as rewritten.
    return { additions: n, deletions: m };
  }
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}
