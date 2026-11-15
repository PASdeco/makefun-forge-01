// GraphQL v4 surface: a small parser and executor covering the documents gh and
// github-mcp-server send (viewer, repository reads, issue and pull connections, the five
// mutations, node(id:) and the __type introspection probes), over the shared Forge store.

import { Forge, VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import { pullFiles } from './rest.ts';
import { nextTimestamp } from './store.ts';

// ---------------------------------------------------------------- ids

export function globalId(type: string, databaseId: number): string {
  return Buffer.from(`${type}:${databaseId}`).toString('base64');
}

function parseGlobalId(id: string): { type: string; databaseId: number } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
    if (!match) return null;
    return { type: match[1], databaseId: Number(match[2]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer and parser

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'spread'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if ('{}()[]:$=!@|'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        tokens.push({ kind: 'string', value: source.slice(index + 3, end === -1 ? source.length : end) });
        index = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const esc = source[index + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (index < source.length && /[0-9.eE+-]/.test(source[index])) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let value = '';
      while (index < source.length && /[_0-9A-Za-z]/.test(source[index])) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    index += 1;
  }
  return tokens;
}

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Map<string, Value> }
  | { kind: 'variable'; name: string };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selection: FieldNode[] | null;
  fragmentType: string | null; // inline fragment condition, when this node is a fragment spread-in-place
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (!token) throw new Error('unexpected end of document');
    return token;
  }
  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.value === '(') depth += 1;
      else if (token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.value === '(') this.skipParens(); // variable definitions
        // Directives after the operation name: skip any @directive(...) groups.
        while (this.peek()?.value === '@') {
          this.next();
          this.next();
          if (this.peek()?.value === '(') this.skipParens();
        }
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.next(); // fragment name
        this.next(); // 'on'
        this.next(); // type name
        this.parseSelectionSet();
      } else {
        this.next();
      }
    }
    return operations;
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() && this.peek()!.value !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    const token = this.next();
    if (token.kind === 'spread') {
      const on = this.next(); // 'on'
      if (on.value !== 'on') throw new Error('only inline fragments are supported');
      const typeName = this.next().value;
      const selection = this.parseSelectionSet();
      return { name: '', alias: null, args: new Map(), selection, fragmentType: typeName };
    }
    let name = token.value;
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = new Map<string, Value>();
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() && this.peek()!.value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    while (this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.value === '(') this.skipParens();
    }
    const selection = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selection, fragmentType: null };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.value === '[') {
      const values: Value[] = [];
      while (this.peek() && this.peek()!.value !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() && this.peek()!.value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, variables);
      return out;
    }
    case 'variable':
      return variables[value.name];
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- schema (for introspection and validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue', 'updateIssue', 'updatePullRequest'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'viewerCanAdminister', 'primaryLanguage', 'stargazerCount', 'forkCount',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'committedDate', 'author'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'labels', 'comments', 'repository', 'viewerCanUpdate',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'isDraft',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'files', 'commits', 'repository', 'mergeCommit',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'interfaces'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Resolver = (source: unknown, args: Record<string, unknown>, ctx: Ctx) => unknown;

function userObject(): Record<string, unknown> {
  return { __type: 'User', id: globalId('User', VIEWER.id), databaseId: VIEWER.id, login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
}

function repoSource(repo: Repo): Record<string, unknown> {
  return { __type: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __type: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __type: 'PullRequest', repo, pull };
}

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`).toString('base64');
}

function seqOfCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function connection<T extends { seq: number }>(
  items: T[],
  args: Record<string, unknown>,
  wrap: (item: T) => unknown,
  descending: boolean,
): Record<string, unknown> {
  const sorted = [...items].sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  let startIndex = 0;
  if (typeof args.after === 'string' && args.after) {
    const afterSeq = seqOfCursor(args.after);
    const found = sorted.findIndex((item) => item.seq === afterSeq);
    if (found >= 0) startIndex = found + 1;
  }
  const first = typeof args.first === 'number' ? args.first : sorted.length;
  const page = sorted.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < sorted.length;
  return {
    __type: 'Connection',
    nodes: page.map(wrap),
    edges: page.map((item) => ({ node: wrap(item), cursor: cursorOf(item.seq) })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length ? cursorOf(page[0].seq) : null,
      endCursor: page.length ? cursorOf(page[page.length - 1].seq) : null,
    },
    totalCount: sorted.length,
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(),
    user: () => userObject(),
    repository: (_source, args, ctx) => {
      if (args.owner !== VIEWER.login) return null;
      const repo = ctx.forge.getRepo(String(args.name ?? ''));
      return repo ? repoSource(repo) : null;
    },
    node: (_source, args, ctx) => {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        for (const repo of ctx.forge.repos.values()) {
          if (repo.id === parsed.databaseId) return repoSource(repo);
        }
      }
      if (parsed.type === 'User') return userObject();
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        for (const repo of ctx.forge.repos.values()) {
          const map = parsed.type === 'Issue' ? repo.issues : repo.pulls;
          for (const item of map.values()) {
            if (item.databaseId === parsed.databaseId) {
              return parsed.type === 'Issue' ? issueSource(repo, item as Issue) : pullSource(repo, item as Pull);
            }
          }
        }
      }
      return null;
    },
    __type: (_source, args) => ({ __type: '__Type', name: String(args.name ?? '') }),
    __schema: () => ({ __type: '__Schema' }),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      let repo: Repo | undefined;
      if (parsed?.type === 'Repository') repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === parsed.databaseId);
      if (!repo) throw new Error('repository not found');
      const { iso } = nextTimestamp();
      const number = repo.nextIssueNumber++;
      const issue: Issue = {
        number,
        databaseId: ctx.forge.allocDatabaseId(),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: iso,
        updatedAt: iso,
        seq: number,
      };
      if (Array.isArray(input.labelIds)) {
        // Labels by global id are not used by the suite; names via label names are ignored here.
      }
      repo.issues.set(number, issue);
      return { __type: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (parsed?.type === 'Issue') {
        for (const repo of ctx.forge.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.databaseId === parsed.databaseId) {
              issue.state = 'closed';
              issue.updatedAt = nextTimestamp().iso;
              return { __type: 'CloseIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
            }
          }
        }
      }
      throw new Error('issue not found');
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      let repo: Repo | undefined;
      if (parsed?.type === 'Repository') repo = [...ctx.forge.repos.values()].find((candidate) => candidate.id === parsed.databaseId);
      if (!repo) throw new Error('repository not found');
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRefName}`);
      if (!headSha || !repo.refs.get(`refs/heads/${baseRefName}`)) throw new Error('head or base ref does not exist');
      const { iso } = nextTimestamp();
      const number = repo.nextIssueNumber++;
      const pull: Pull = {
        number,
        databaseId: ctx.forge.allocDatabaseId(),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: headRefName,
        baseRef: baseRefName,
        headSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: iso,
        updatedAt: iso,
        seq: number,
      };
      repo.pulls.set(number, pull);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (parsed?.type === 'PullRequest') {
        for (const repo of ctx.forge.repos.values()) {
          for (const pull of repo.pulls.values()) {
            if (pull.databaseId === parsed.databaseId) {
              if (pull.state === 'open') {
                const sha = ctx.forge.squashMerge(repo, pull);
                if (sha === null) throw new Error('Pull Request is not mergeable');
              }
              return { __type: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null };
            }
          }
        }
      }
      throw new Error('pull request not found');
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (parsed?.type === 'Issue' || parsed?.type === 'PullRequest') {
        for (const repo of ctx.forge.repos.values()) {
          const map = parsed.type === 'Issue' ? repo.issues : repo.pulls;
          for (const item of map.values()) {
            if (item.databaseId === parsed.databaseId) {
              const { iso } = nextTimestamp();
              const comment = { id: ctx.forge.allocCommentId(), body: String(input.body ?? ''), createdAt: iso, updatedAt: iso };
              if (parsed.type === 'Issue') (item as Issue).comments.push(comment);
              const node = { __type: 'IssueComment', comment, repo };
              return {
                __type: 'AddCommentPayload',
                commentEdge: { __type: 'CommentEdge', node, cursor: cursorOf(comment.id) },
                subject: parsed.type === 'Issue' ? issueSource(repo, item as Issue) : pullSource(repo, item as Pull),
                clientMutationId: input.clientMutationId ?? null,
              };
            }
          }
        }
      }
      throw new Error('subject not found');
    },
  },
  User: {
    id: (source) => (source as Record<string, unknown>).id,
    databaseId: (source) => (source as Record<string, unknown>).databaseId,
    login: (source) => (source as Record<string, unknown>).login,
    name: (source) => (source as Record<string, unknown>).name,
    email: (source) => (source as Record<string, unknown>).email,
    url: () => `https://github.com/${VIEWER.login}`,
    avatarUrl: () => 'https://github.com/identicons/forge.png',
    isViewer: () => true,
  },
  Repository: {
    id: (source) => globalId('Repository', (source as { repo: Repo }).repo.id),
    databaseId: (source) => (source as { repo: Repo }).repo.id,
    name: (source) => (source as { repo: Repo }).repo.name,
    nameWithOwner: (source) => `${VIEWER.login}/${(source as { repo: Repo }).repo.name}`,
    owner: () => userObject(),
    defaultBranchRef: (source, _args, ctx) => {
      const repo = (source as { repo: Repo }).repo;
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: sha ? { __type: 'Commit', oid: sha } : null, repo };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    isPrivate: (source) => (source as { repo: Repo }).repo.isPrivate,
    description: (source) => (source as { repo: Repo }).repo.description,
    url: (source) => `https://github.com/${VIEWER.login}/${(source as { repo: Repo }).repo.name}`,
    createdAt: (source) => (source as { repo: Repo }).repo.createdAt,
    updatedAt: (source) => (source as { repo: Repo }).repo.updatedAt,
    viewerCanAdminister: () => true,
    issue: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueSource(repo, issue) : null;
    },
    issues: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const descending = orderBy?.direction ? orderBy.direction === 'DESC' : true;
      return { ...(connection(issues, args, (issue) => issueSource(repo, issue), descending) as Record<string, unknown>), __type: 'IssueConnection' };
    },
    pullRequest: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullSource(repo, pull) : null;
    },
    pullRequests: (source, args) => {
      const repo = (source as { repo: Repo }).repo;
      let pulls = [...repo.pulls.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      return { ...(connection(pulls, args, (pull) => pullSource(repo, pull), true) as Record<string, unknown>), __type: 'PullRequestConnection' };
    },
  },
  Ref: {
    name: (source) => (source as Record<string, unknown>).name,
    prefix: (source) => (source as Record<string, unknown>).prefix,
    target: (source) => (source as Record<string, unknown>).target,
  },
  Commit: {
    id: (source) => globalId('Commit', 0) && Buffer.from(`Commit:${(source as Record<string, unknown>).oid}`).toString('base64'),
    oid: (source) => (source as Record<string, unknown>).oid,
  },
  Issue: {
    id: (source) => globalId('Issue', (source as { issue: Issue }).issue.databaseId),
    databaseId: (source) => (source as { issue: Issue }).issue.databaseId,
    number: (source) => (source as { issue: Issue }).issue.number,
    title: (source) => (source as { issue: Issue }).issue.title,
    body: (source) => (source as { issue: Issue }).issue.body,
    state: (source) => (source as { issue: Issue }).issue.state.toUpperCase(),
    url: (source) => `https://github.com/${VIEWER.login}/${(source as { repo: Repo }).repo.name}/issues/${(source as { issue: Issue }).issue.number}`,
    createdAt: (source) => (source as { issue: Issue }).issue.createdAt,
    updatedAt: (source) => (source as { issue: Issue }).issue.updatedAt,
    closedAt: (source) => ((source as { issue: Issue }).issue.state === 'closed' ? (source as { issue: Issue }).issue.updatedAt : null),
    author: () => userObject(),
    repository: (source) => repoSource((source as { repo: Repo }).repo),
    labels: (source, args) => {
      const { repo, issue } = source as { repo: Repo; issue: Issue };
      const nodes = issue.labels.map((name) => ({ __type: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null, id: globalId('Label', 1) }));
      return { __type: 'Connection', nodes, pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length, edges: [] };
    },
    comments: (source, args) => {
      const { issue } = source as { issue: Issue };
      const items = issue.comments.map((comment) => ({ seq: comment.id, comment }));
      return connection(items, args, (item) => ({ __type: 'IssueComment', comment: item.comment }), false);
    },
    viewerCanUpdate: () => true,
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source as { pull: Pull }).pull.databaseId),
    databaseId: (source) => (source as { pull: Pull }).pull.databaseId,
    number: (source) => (source as { pull: Pull }).pull.number,
    title: (source) => (source as { pull: Pull }).pull.title,
    body: (source) => (source as { pull: Pull }).pull.body,
    state: (source) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source as { pull: Pull }).pull.merged,
    mergedAt: (source) => (source as { pull: Pull }).pull.mergedAt,
    mergeable: (source, _args, ctx) => {
      const { repo, pull } = source as { repo: Repo; pull: Pull };
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    isDraft: () => false,
    headRefName: (source) => (source as { pull: Pull }).pull.headRef,
    baseRefName: (source) => (source as { pull: Pull }).pull.baseRef,
    headRefOid: (source) => {
      const { repo, pull } = source as { repo: Repo; pull: Pull };
      return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    },
    baseRefOid: (source) => {
      const { repo, pull } = source as { repo: Repo; pull: Pull };
      return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
    },
    url: (source) => `https://github.com/${VIEWER.login}/${(source as { repo: Repo }).repo.name}/pull/${(source as { pull: Pull }).pull.number}`,
    createdAt: (source) => (source as { pull: Pull }).pull.createdAt,
    updatedAt: (source) => (source as { pull: Pull }).pull.updatedAt,
    closedAt: (source) => ((source as { pull: Pull }).pull.state === 'closed' ? (source as { pull: Pull }).pull.updatedAt : null),
    author: () => userObject(),
    repository: (source) => repoSource((source as { repo: Repo }).repo),
    mergeCommit: (source) => {
      const pull = (source as { pull: Pull }).pull;
      return pull.mergeCommitSha ? { __type: 'Commit', oid: pull.mergeCommitSha } : null;
    },
    files: (source, args, ctx) => {
      const { repo, pull } = source as { repo: Repo; pull: Pull };
      const files = pullFiles(ctx.forge, repo, pull).map((file, index) => ({
        seq: index + 1,
        node: {
          __type: 'PullRequestFile',
          path: String(file.filename),
          additions: Number(file.additions),
          deletions: Number(file.deletions),
          changeType: String(file.status).toUpperCase(),
        },
      }));
      const conn = connection(files, args, (item) => item.node, false) as Record<string, unknown>;
      return { ...conn, __type: 'PullRequestFileConnection' };
    },
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', (source as { comment: { id: number } }).comment.id),
    databaseId: (source) => (source as { comment: { id: number } }).comment.id,
    body: (source) => (source as { comment: { body: string } }).comment.body,
    createdAt: (source) => (source as { comment: { createdAt: string } }).comment.createdAt,
    updatedAt: (source) => (source as { comment: { updatedAt: string } }).comment.updatedAt,
    author: () => userObject(),
  },
  Label: {
    id: (source) => (source as Record<string, unknown>).id,
    name: (source) => (source as Record<string, unknown>).name,
    color: (source) => (source as Record<string, unknown>).color,
    description: (source) => (source as Record<string, unknown>).description,
  },
  PullRequestFile: {
    path: (source) => (source as Record<string, unknown>).path,
    additions: (source) => (source as Record<string, unknown>).additions,
    deletions: (source) => (source as Record<string, unknown>).deletions,
    changeType: (source) => (source as Record<string, unknown>).changeType,
  },
  PageInfo: {
    hasNextPage: (source) => (source as Record<string, unknown>).hasNextPage,
    hasPreviousPage: (source) => (source as Record<string, unknown>).hasPreviousPage,
    startCursor: (source) => (source as Record<string, unknown>).startCursor,
    endCursor: (source) => (source as Record<string, unknown>).endCursor,
  },
  __Type: {
    name: (source) => (source as Record<string, unknown>).name,
    kind: (source) => {
      const name = String((source as Record<string, unknown>).name);
      if (ENUM_TYPES[name]) return 'ENUM';
      if (name === 'Query' || name === 'Mutation') return 'OBJECT';
      return TYPE_FIELDS[name] ? 'OBJECT' : 'OBJECT';
    },
    description: () => null,
    fields: (source) => {
      const name = String((source as Record<string, unknown>).name);
      const fields = TYPE_FIELDS[name];
      if (!fields) return null;
      return fields.map((fieldName) => ({ __type: '__Field', name: fieldName }));
    },
    enumValues: (source) => {
      const name = String((source as Record<string, unknown>).name);
      const values = ENUM_TYPES[name];
      if (!values) return null;
      return values.map((value) => ({ __type: '__EnumValue', name: value }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    interfaces: () => [],
  },
  __Field: {
    name: (source) => (source as Record<string, unknown>).name,
    description: () => null,
    args: () => [],
    type: () => ({ __type: '__Type', name: 'String' }),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (source) => (source as Record<string, unknown>).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_TYPES)].map((name) => ({ __type: '__Type', name })),
    queryType: () => ({ __type: '__Type', name: 'Query' }),
    mutationType: () => ({ __type: '__Type', name: 'Mutation' }),
    subscriptionType: () => null,
    directives: () => [],
  },
};

// Payload and connection types resolve generically.
for (const payloadType of ['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  RESOLVERS[payloadType] = {
    issue: (source) => (source as Record<string, unknown>).issue ?? null,
    pullRequest: (source) => (source as Record<string, unknown>).pullRequest ?? null,
    commentEdge: (source) => (source as Record<string, unknown>).commentEdge ?? null,
    subject: (source) => (source as Record<string, unknown>).subject ?? null,
    clientMutationId: (source) => (source as Record<string, unknown>).clientMutationId ?? null,
  };
}
for (const connType of ['Connection', 'IssueConnection', 'PullRequestConnection', 'PullRequestFileConnection']) {
  RESOLVERS[connType] = {
    nodes: (source) => (source as Record<string, unknown>).nodes,
    edges: (source) => (source as Record<string, unknown>).edges,
    pageInfo: (source) => (source as Record<string, unknown>).pageInfo,
    totalCount: (source) => (source as Record<string, unknown>).totalCount,
  };
}
RESOLVERS['CommentEdge'] = {
  node: (source) => (source as Record<string, unknown>).node,
  cursor: (source) => (source as Record<string, unknown>).cursor,
};
for (const edgeType of ['IssueEdge', 'PullRequestEdge']) {
  RESOLVERS[edgeType] = RESOLVERS['CommentEdge'];
}

function runtimeType(source: unknown): string {
  if (source === null || source === undefined) return 'Query';
  const type = (source as Record<string, unknown>).__type;
  return typeof type === 'string' ? type : 'Query';
}

function executeSelection(source: unknown, typeName: string, selection: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const resolvers = RESOLVERS[typeName] ?? {};
  const knownFields = TYPE_FIELDS[typeName];
  for (const field of selection) {
    if (field.fragmentType) {
      if (field.fragmentType === typeName || typeName === 'Query') {
        Object.assign(out, executeSelection(source, typeName, field.selection ?? [], ctx));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const resolver = resolvers[field.name];
    if (!resolver) {
      if (knownFields && !knownFields.includes(field.name) && !field.name.startsWith('__')) {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      }
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(source, argsOf(field, ctx.variables), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object' && field.selection) {
    return executeSelection(value, runtimeType(value), field.selection, ctx);
  }
  return value;
}

/** Execute one GraphQL request body ({query, variables, operationName}) and return the result body. */
export function executeGraphQL(forge: Forge, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeGraphQL(forge, entry).body);
    return { status: 200, body: results };
  }
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  let operations: Operation[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { status: 200, body: { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] } };
  }
  if (!operations.length) return { status: 200, body: { errors: [{ message: 'no operation found' }] } };
  const operation = operationName ? operations.find((candidate) => candidate.name === operationName) ?? operations[0] : operations[0];
  const ctx: Ctx = { forge, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(null, rootType, operation.selection, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return { status: 200, body: result };
}
