// MCP endpoint: JSON-RPC 2.0 over streamable HTTP. Speaks the 2026-07-28 revision through
// server/discover and the handshake revisions through initialize. The six required tools act on
// the same Forge store as REST, so effects read back identically on every surface.

import { Forge, VIEWER, nextTimestamp, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'bailout-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const fullName = str(args.full_name);
  const name = str(args.repo) || (fullName.includes('/') ? fullName.split('/')[1] : '');
  const owner = str(args.owner) || (fullName.includes('/') ? fullName.split('/')[0] : VIEWER.login);
  if (owner !== VIEWER.login) throw new Error(`repository ${owner}/${name} not found`);
  const repo = forge.getRepo(name);
  if (!repo) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (forge, args) => {
      const name = str(args.name);
      if (!name) throw new Error('name is required');
      let repo = forge.getRepo(name);
      if (!repo) {
        repo = forge.createRepo(name, { description: str(args.description), isPrivate: args.private === true })!;
      }
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => repoJson(findRepo(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const number = repo.nextIssueNumber++;
      const issue = {
        number,
        databaseId: forge.allocDatabaseId(),
        title: str(args.title),
        body: str(args.body),
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        createdAt: nextTimestamp().iso,
        updatedAt: nextTimestamp().iso,
        seq: number,
      };
      repo.issues.set(number, issue);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const state = str(args.state) || 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const list = issues.map((issue) => issueJson(repo, issue));
      return { issues: list, total_count: list.length };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const head = str(args.head).replace(/^[^:]+:/, '');
      const base = str(args.base).replace(/^[^:]+:/, '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      if (!headSha || !repo.refs.get(`refs/heads/${base}`)) throw new Error('head or base branch does not exist');
      const number = repo.nextIssueNumber++;
      const pull = {
        number,
        databaseId: forge.allocDatabaseId(),
        title: str(args.title),
        body: str(args.body),
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        headSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: nextTimestamp().iso,
        updatedAt: nextTimestamp().iso,
        seq: number,
      };
      repo.pulls.set(number, pull);
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/name pair.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const number = Number(args.pull_number ?? args.number);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`pull request ${number} not found`);
      if (pull.state === 'open') {
        const sha = forge.squashMerge(repo, pull);
        if (sha === null) throw new Error('Pull Request is not mergeable');
      }
      return pullJson(forge, repo, pull);
    },
  },
];

function toolList(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: true,
    },
  }));
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export interface McpOutcome {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Handle one MCP request body (already JSON-parsed). Notifications answer 202 with no body. */
export function handleMcp(forge: Forge, body: unknown): McpOutcome {
  if (Array.isArray(body)) {
    const results = body.map((entry) => handleMcp(forge, entry)).filter((outcome) => outcome.body !== undefined);
    if (!results.length) return { status: 202 };
    return { status: 200, body: results.map((outcome) => outcome.body) };
  }
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const method = str(request.method);
  const id = request.id;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: '2026-07-28',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      };
    case 'initialize': {
      const requested = str(params.protocolVersion);
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
        headers: { 'mcp-session-id': 'forge-session-1' },
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202 };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: toolList() }) };
    case 'tools/call': {
      const name = str(params.name);
      const tool = TOOLS.find((candidate) => candidate.name === name)
        ?? TOOLS.find((candidate) => name.toLowerCase().endsWith(candidate.name));
      if (!tool) return { status: 200, body: rpcError(id, -32602, `unknown tool: ${name}`) };
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      // full_name fills owner/repo when the caller used it.
      if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
        const [owner, repo] = (args.full_name as string).split('/');
        if (!args.owner) args.owner = owner;
        if (!args.repo) args.repo = repo;
      }
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === '') {
          return {
            status: 200,
            body: rpcResult(id, {
              content: [{ type: 'text', text: `missing required argument: ${required}` }],
              isError: true,
            }),
          };
        }
      }
      try {
        const result = tool.run(forge, args);
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          }),
        };
      } catch (err) {
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }),
        };
      }
    }
    default:
      if (isNotification) return { status: 202 };
      return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
  }
}
