// REST v3 surface: repositories, branches, commits, contents, labels, issues, comments, pulls.
// Shapes follow GitHub's; every value comes from the shared Forge store so GraphQL and MCP see
// the same objects.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER, lineDiff, nextTimestamp, type Issue, type Pull, type Repo } from './store.ts';
import { parseCommit, peelToCommit } from './gitcore.ts';

export interface HttpResult {
  status: number;
  body?: unknown;
  rawBody?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, body, headers };
}

export function notFound(): HttpResult {
  return json(404, { message: 'Not Found' });
}

function ownerJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: ownerJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://github.com/${VIEWER.login}/${repo.name}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (!label) return null;
  return {
    id: [...repo.labels.keys()].indexOf(name) + 1,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.databaseId,
    node_id: Buffer.from(`Issue:${issue.databaseId}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((value) => value !== null),
    user: ownerJson(),
    author: ownerJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.databaseId,
    node_id: Buffer.from(`PullRequest:${pull.databaseId}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: ownerJson(),
    author: ownerJson(),
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}`, repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? forge.pullMergeable(repo, pull) : null,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: ownerJson(),
    author: ownerJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

/** Parse a request's JSON body; `undefined` when absent, the symbol BAD when malformed. */
export const BAD_JSON = Symbol('bad-json');
export function parseBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return BAD_JSON;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The /api/v3 router. `segments` is the path after /api/v3, already URL-decoded per segment. */
export function routeRest(
  forge: Forge,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
): HttpResult {
  if (body === BAD_JSON) return json(400, { message: 'Problems parsing JSON' });
  const data = asObject(body);

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return json(200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0-forge',
      github_services_sha: 'forge',
      actions_runner_registration_url: '/api/v3/actions/runners/registration-token',
    });
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound();
    return json(200, { ...ownerJson(), name: VIEWER.name, email: VIEWER.email });
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(forge, query, host);
    if (method === 'POST') return createRepo(forge, data);
    return notFound();
  }
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1];
  const repoName = segments[2];
  if (owner !== VIEWER.login) return notFound();
  const repo = forge.getRepo(repoName);
  if (!repo) return notFound();
  const rest = segments.slice(3);
  return routeRepo(forge, repo, method, rest, query, data);
}

function listUserRepos(forge: Forge, query: URLSearchParams, host: string): HttpResult {
  const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const next = `http://${host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
    const lastPage = Math.ceil(all.length / perPage);
    const last = `http://${host}/api/v3/user/repos?page=${lastPage}&per_page=${perPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return json(200, slice.map(repoJson), headers);
}

function createRepo(forge: Forge, data: Record<string, unknown>): HttpResult {
  const name = str(data.name);
  if (!name) return json(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is required' }] });
  const existing = forge.getRepo(name);
  if (existing) {
    return json(422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const repo = forge.createRepo(name, {
    description: str(data.description),
    isPrivate: typeof data.private === 'boolean' ? data.private : false,
    defaultBranch: str(data.default_branch) || undefined,
  })!;
  if (data.auto_init === true) {
    forge.commitUpdates(repo, repo.defaultBranch, new Map(), 'Initial commit');
  }
  return json(201, repoJson(repo));
}

function routeRepo(
  forge: Forge,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  data: Record<string, unknown>,
): HttpResult {
  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.name === 'string' && data.name && data.name !== repo.name) {
        forge.repos.delete(repo.name);
        repo.name = data.name;
        forge.repos.set(repo.name, repo);
      }
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      if (typeof data.default_branch === 'string' && data.default_branch) repo.defaultBranch = data.default_branch;
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  // /git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(data.ref);
      const sha = str(data.sha);
      if (!ref.startsWith('refs/') || !forge.store.has(sha)) return json(422, { message: 'Validation Failed' });
      repo.refs.set(ref, sha);
      return json(201, { ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), url: '', object: { sha, type: forge.store.get(sha)!.type, url: '' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (!sha) return notFound();
      return json(200, { ref: full, object: { sha, type: forge.store.get(sha)?.type ?? 'commit', url: '' } });
    }
    return notFound();
  }

  // /branches
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
    return json(200, branches);
  }
  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${rest[1]}`);
    if (!sha) return notFound();
    return json(200, { name: rest[1], commit: { sha, url: '' }, protected: false });
  }

  // /commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const refName = query.get('sha') ?? repo.defaultBranch;
    const tip = forge.refSha(repo, refName);
    if (!tip) return json(200, []);
    const commits: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = [peelToCommit(forge.store, tip)];
    while (queue.length && commits.length < 500) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = forge.store.get(sha);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      commits.push({
        sha,
        node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
        commit: {
          message: commit.message.replace(/\n$/, ''),
          tree: { sha: commit.tree, url: '' },
          author: parseIdent(commit.author),
          committer: parseIdent(commit.committer),
          comment_count: 0,
        },
        author: ownerJson(),
        committer: ownerJson(),
        parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
        url: '',
        html_url: '',
      });
      queue.push(...commit.parents);
    }
    return json(200, commits);
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const object = forge.store.get(rest[1]);
    if (!object || object.type !== 'commit') return notFound();
    const commit = parseCommit(object.data);
    return json(200, {
      sha: rest[1],
      commit: {
        message: commit.message.replace(/\n$/, ''),
        tree: { sha: commit.tree, url: '' },
        author: parseIdent(commit.author),
        committer: parseIdent(commit.committer),
        comment_count: 0,
      },
      author: ownerJson(),
      committer: ownerJson(),
      parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
    });
  }

  // /contents/{path...}
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(forge, repo, path, query.get('ref') ?? undefined);
    if (method === 'PUT') return putContents(forge, repo, path, data);
    if (method === 'DELETE') return deleteContents(forge, repo, path, data);
    return notFound();
  }

  // /labels
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return json(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
      if (method === 'POST') {
        const name = str(data.name);
        if (!name) return json(422, { message: 'Validation Failed' });
        if (repo.labels.has(name)) return json(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        repo.labels.set(name, {
          name,
          color: (str(data.color) || 'ededed').replace(/^#/, ''),
          description: typeof data.description === 'string' ? data.description : null,
        });
        return json(201, labelJson(repo, name));
      }
      return notFound();
    }
    if (rest.length === 2 && method === 'GET') {
      const found = labelJson(repo, decodeURIComponent(rest[1]));
      return found ? json(200, found) : notFound();
    }
    return notFound();
  }

  // /issues and /issues/{n}[/comments]
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(forge, repo, data);
      if (method === 'GET') return listIssues(repo, query);
      return notFound();
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (!issue) return notFound();
      if (method === 'GET') return json(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        if (typeof data.title === 'string') issue.title = data.title;
        if (typeof data.body === 'string') issue.body = data.body;
        if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
        if (Array.isArray(data.labels)) {
          const names = data.labels.map((entry) => (typeof entry === 'string' ? entry : str(asObject(entry).name)));
          for (const name of names) if (!repo.labels.has(name)) return json(422, { message: 'Validation Failed' });
          issue.labels = names;
        }
        issue.updatedAt = nextTimestamp().iso;
        return json(200, issueJson(repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return notFound();
      if (method === 'POST') {
        const body = str(data.body);
        const { iso } = nextTimestamp();
        const comment = { id: forge.allocCommentId(), body, createdAt: iso, updatedAt: iso };
        issue.comments.push(comment);
        return json(201, commentJson(comment));
      }
      if (method === 'GET') return json(200, issue.comments.map(commentJson));
      return notFound();
    }
    return notFound();
  }

  // /pulls and /pulls/{n}[/files|/merge]
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(forge, repo, data);
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const all = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
        const filtered = state === 'all' ? all : all.filter((pull) => pull.state === state);
        return json(200, filtered.map((pull) => pullJson(forge, repo, pull)));
      }
      return notFound();
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2) {
      if (!pull) return notFound();
      if (method === 'GET') return json(200, pullJson(forge, repo, pull));
      if (method === 'PATCH') {
        if (typeof data.title === 'string') pull.title = data.title;
        if (typeof data.body === 'string') pull.body = data.body;
        if (data.state === 'open' || data.state === 'closed') pull.state = data.state;
        pull.updatedAt = nextTimestamp().iso;
        return json(200, pullJson(forge, repo, pull));
      }
      return notFound();
    }
    if (!pull) return notFound();
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return json(200, pullFiles(forge, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.state !== 'open' || pull.merged) return json(405, { message: 'Pull Request is not mergeable' });
      const sha = forge.squashMerge(repo, pull);
      if (sha === null) return json(405, { message: 'Pull Request is not mergeable' });
      return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function getContents(forge: Forge, repo: Repo, path: string, ref: string | undefined): HttpResult {
  const tip = forge.refSha(repo, ref ?? repo.defaultBranch);
  if (!tip) return notFound();
  const flat = forge.flatOfCommit(tip);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    return json(200, directoryListing(forge, repo, flat, ''));
  }
  const file = flat.get(clean);
  if (file) {
    const blob = forge.store.get(file.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: file.oid,
      size: data.length,
      name: clean.split('/').pop(),
      path: clean,
      url: '',
      html_url: '',
      download_url: '',
    });
  }
  const prefix = `${clean}/`;
  if ([...flat.keys()].some((key) => key.startsWith(prefix))) {
    return json(200, directoryListing(forge, repo, flat, clean));
  }
  return notFound();
}

function directoryListing(
  forge: Forge,
  repo: Repo,
  flat: Map<string, { oid: string; mode: string }>,
  dir: string,
): Record<string, unknown>[] {
  const prefix = dir ? `${dir}/` : '';
  const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
  for (const [path, value] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const blob = forge.store.get(value.oid);
      entries.set(rest, { type: 'file', name: rest, path, sha: value.oid, size: blob?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) {
        // Directory sha: the subtree's tree sha, recomputed from the flat map.
        const sub = new Map<string, { oid: string; mode: string }>();
        for (const [subPath, subValue] of flat) {
          if (subPath.startsWith(`${prefix}${name}/`)) sub.set(subPath.slice(prefix.length + name.length + 1), subValue);
        }
        entries.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: forge.buildTreeFromFlat(sub), size: 0 });
      }
    }
  }
  return [...entries.values()]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) => ({ ...entry, url: '', html_url: '', download_url: null }));
}

function putContents(forge: Forge, repo: Repo, path: string, data: Record<string, unknown>): HttpResult {
  const clean = path.replace(/^\/+/, '');
  if (!clean) return json(422, { message: 'Validation Failed' });
  const branch = str(data.branch) || repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const flat = tip ? forge.flatOfCommit(tip) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(clean);
  const providedSha = str(data.sha);
  if (existing && providedSha && providedSha !== existing.oid) {
    return json(409, { message: 'Conflict: the file has changed since the sha was read' });
  }
  if (existing && !providedSha) {
    return json(422, { message: 'Validation Failed', errors: [{ resource: 'Contents', code: 'custom', field: 'sha', message: 'sha is required when updating a file' }] });
  }
  if (!existing && providedSha) {
    return json(422, { message: 'Validation Failed' });
  }
  const content = Buffer.from(str(data.content).replace(/\s+/g, ''), 'base64');
  const blobSha = forge.store.put('blob', content);
  const updates = new Map<string, { oid: string; mode: string } | null>([[clean, { oid: blobSha, mode: '100644' }]]);
  const commitSha = forge.commitUpdates(repo, branch, updates, str(data.message) || 'Update file');
  return json(existing ? 200 : 201, {
    content: {
      type: 'file',
      encoding: 'base64',
      sha: blobSha,
      size: content.length,
      name: clean.split('/').pop(),
      path: clean,
      url: '',
      html_url: '',
      download_url: '',
    },
    commit: { sha: commitSha, url: '', message: str(data.message) || 'Update file', author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
  });
}

function deleteContents(forge: Forge, repo: Repo, path: string, data: Record<string, unknown>): HttpResult {
  const clean = path.replace(/^\/+/, '');
  const branch = str(data.branch) || repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return notFound();
  const flat = forge.flatOfCommit(tip);
  const existing = flat.get(clean);
  if (!existing) return notFound();
  const providedSha = str(data.sha);
  if (providedSha && providedSha !== existing.oid) return json(409, { message: 'Conflict' });
  const updates = new Map<string, { oid: string; mode: string } | null>([[clean, null]]);
  const commitSha = forge.commitUpdates(repo, branch, updates, str(data.message) || 'Delete file');
  return json(200, { content: null, commit: { sha: commitSha, url: '', message: str(data.message) || 'Delete file' } });
}

function createIssue(forge: Forge, repo: Repo, data: Record<string, unknown>): HttpResult {
  const labelNames: string[] = [];
  if (Array.isArray(data.labels)) {
    for (const entry of data.labels) {
      const name = typeof entry === 'string' ? entry : str(asObject(entry).name);
      if (!repo.labels.has(name)) return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${name}" does not exist` }] });
      labelNames.push(name);
    }
  }
  const { iso } = nextTimestamp();
  const number = repo.nextIssueNumber++;
  const issue: Issue = {
    number,
    databaseId: forge.allocDatabaseId(),
    title: str(data.title),
    body: typeof data.body === 'string' ? data.body : '',
    state: 'open',
    labels: labelNames,
    comments: [],
    createdAt: iso,
    updatedAt: iso,
    seq: number,
  };
  repo.issues.set(number, issue);
  return json(201, issueJson(repo, issue));
}

function listIssues(repo: Repo, query: URLSearchParams): HttpResult {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  issues = issues.slice((page - 1) * perPage, page * perPage);
  return json(200, issues.map((issue) => issueJson(repo, issue)));
}

function createPull(forge: Forge, repo: Repo, data: Record<string, unknown>): HttpResult {
  const head = str(data.head).replace(/^[^:]+:/, '');
  const base = str(data.base).replace(/^[^:]+:/, '');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) {
    return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: !headSha ? 'head' : 'base', message: 'the ref does not exist' }] });
  }
  const { iso } = nextTimestamp();
  const number = repo.nextIssueNumber++;
  const pull: Pull = {
    number,
    databaseId: forge.allocDatabaseId(),
    title: str(data.title),
    body: typeof data.body === 'string' ? data.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: iso,
    updatedAt: iso,
    seq: number,
  };
  repo.pulls.set(number, pull);
  return json(201, pullJson(forge, repo, pull));
}

export function pullFiles(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseSha) return [];
  const mergeBase = forge.mergeBase(baseSha, headSha);
  const baseFlat = mergeBase ? forge.flatOfCommit(mergeBase) : new Map<string, { oid: string; mode: string }>();
  const headFlat = forge.flatOfCommit(headSha);
  const files: Record<string, unknown>[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    const oldText = before ? (forge.store.get(before.oid)?.data.toString('utf8') ?? '') : '';
    const newText = after ? (forge.store.get(after.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    files.push({
      sha: after?.oid ?? before!.oid,
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return files;
}
