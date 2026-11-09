import { AppError } from '../errors.js';
import type { InstallationTokenProvider } from './app-token.js';

export class RefConflictError extends Error {
  constructor(message = 'ref update is not a fast-forward') {
    super(message);
    this.name = 'RefConflictError';
  }
}

export type TreeEntry = { path: string; mode: '100644'; type: 'blob'; sha: string | null };

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function rateLimitError(res: Response): AppError | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get('retry-after');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (res.status === 429 || retryAfter || remaining === '0') {
    let seconds = retryAfter ? Number(retryAfter) : NaN;
    if (!Number.isFinite(seconds) && remaining === '0' && reset) seconds = Number(reset) - Math.floor(Date.now() / 1000);
    // Plan §4.8: without Retry-After wait at least 60s before exponential backoff.
    if (!Number.isFinite(seconds) || seconds < 60) seconds = Math.max(60, Number.isFinite(seconds) ? seconds : 60);
    return new AppError(503, 'upstream_rate_limited', 'GitHub rate limit reached; retry later', {
      retryable: true,
      headers: { 'retry-after': String(Math.ceil(seconds)) },
    });
  }
  return null;
}

/** Minimal GitHub REST client for the A repo: refs, commits, Git Data API, contents. */
export class GitHubRepoClient {
  constructor(
    private readonly opts: {
      apiBase: string;
      rawBase: string;
      owner: string;
      repo: string;
      branch: string;
      tokens: InstallationTokenProvider | null;
      fetchImpl?: typeof fetch;
    },
  ) {}

  get owner() {
    return this.opts.owner;
  }
  get repo() {
    return this.opts.repo;
  }
  get canWrite() {
    return this.opts.tokens !== null;
  }

  private get f() {
    return this.opts.fetchImpl ?? fetch;
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sticker-api',
    };
    if (this.opts.tokens) headers.authorization = `Bearer ${await this.opts.tokens.get()}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.f(`${this.opts.apiBase}/repos/${encodeURIComponent(this.opts.owner)}/${encodeURIComponent(this.opts.repo)}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(503, 'upstream_unreachable', 'GitHub API unreachable', { retryable: true });
    }
    const rl = rateLimitError(res);
    if (rl) throw rl;
    return res;
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) {
      throw new AppError(502, 'upstream_error', `GitHub ${what} failed (${res.status})`, { retryable: res.status >= 500 });
    }
    return (await res.json()) as T;
  }

  async getHeadSha(): Promise<string> {
    const res = await this.api('GET', `/git/ref/heads/${encodeURIComponent(this.opts.branch)}`);
    if (res.status === 404) throw new AppError(503, 'repo_uninitialized', 'A repo branch not found');
    const body = await this.json<{ object?: { sha?: string; type?: string } }>(res, 'get ref');
    const sha = body.object?.sha;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new AppError(502, 'upstream_error', 'Malformed ref');
    return sha;
  }

  async getCommit(sha: string): Promise<{ sha: string; tree: string; parents: string[] }> {
    const res = await this.api('GET', `/git/commits/${sha}`);
    const body = await this.json<{ sha: string; tree: { sha: string }; parents: Array<{ sha: string }> }>(res, 'get commit');
    return { sha: body.sha, tree: body.tree.sha, parents: body.parents.map((p) => p.sha) };
  }

  /** Authoritative read at an exact commit through the API (used by the write path). */
  async readFileApi(commit: string, path: string): Promise<Buffer | null> {
    const res = await this.api('GET', `/contents/${encPath(path)}?ref=${commit}`, undefined, 'application/vnd.github.raw+json');
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError(502, 'upstream_error', `GitHub contents read failed (${res.status})`, { retryable: res.status >= 500 });
    return Buffer.from(await res.arrayBuffer());
  }

  /** Public raw read at an exact commit. Never sends credentials. */
  async readFileRaw(commit: string, path: string): Promise<Buffer | null> {
    let res: Response;
    try {
      res = await this.f(`${this.opts.rawBase}/${encodeURIComponent(this.opts.owner)}/${encodeURIComponent(this.opts.repo)}/${commit}/${encPath(path)}`, {
        headers: { 'user-agent': 'sticker-api' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(503, 'upstream_unreachable', 'GitHub raw unreachable', { retryable: true });
    }
    if (res.status === 404) return null;
    const rl = rateLimitError(res);
    if (rl) throw rl;
    if (!res.ok) throw new AppError(502, 'upstream_error', `GitHub raw read failed (${res.status})`, { retryable: true });
    return Buffer.from(await res.arrayBuffer());
  }

  // ---------- Actions (collect workflow). Needs the writer App permission "Actions: Read and write". ----------
  private actionsError(res: Response, what: string): AppError {
    if (res.status === 403 || res.status === 404) {
      // 404 is what GitHub returns for a missing permission on some endpoints, or a missing workflow file.
      return new AppError(503, 'actions_permission', `GitHub ${what} denied (${res.status}): the writer GitHub App needs repository permission "Actions: Read and write", and A must contain the workflow on its default branch`, { retryable: false });
    }
    if (res.status === 422) return new AppError(422, 'workflow_dispatch_rejected', `GitHub rejected the dispatch (422): workflow inputs or ref invalid`, { retryable: false });
    return new AppError(502, 'upstream_error', `GitHub ${what} failed (${res.status})`, { retryable: res.status >= 500 });
  }

  async dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    if (!this.canWrite) throw new AppError(503, 'actions_unconfigured', 'Writer GitHub App not configured');
    const res = await this.api('POST', `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs });
    if (res.status !== 204 && res.status !== 200) throw this.actionsError(res, 'workflow dispatch');
  }

  async listWorkflowRuns(workflow: string, perPage = 10): Promise<Array<Record<string, unknown>>> {
    if (!this.canWrite) throw new AppError(503, 'actions_unconfigured', 'Writer GitHub App not configured');
    const res = await this.api('GET', `/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${perPage}`);
    if (!res.ok) throw this.actionsError(res, 'list workflow runs');
    const body = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
    return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  }

  async createBlob(content: Buffer): Promise<string> {
    const res = await this.api('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' });
    return (await this.json<{ sha: string }>(res, 'create blob')).sha;
  }

  async createTree(baseTree: string, entries: TreeEntry[]): Promise<string> {
    const res = await this.api('POST', '/git/trees', { base_tree: baseTree, tree: entries });
    return (await this.json<{ sha: string }>(res, 'create tree')).sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const res = await this.api('POST', '/git/commits', { message, tree, parents });
    return (await this.json<{ sha: string }>(res, 'create commit')).sha;
  }

  /** force:false => GitHub only accepts a fast-forward. Not an expected-SHA CAS. */
  async updateRef(commit: string): Promise<void> {
    const res = await this.api('PATCH', `/git/refs/heads/${encodeURIComponent(this.opts.branch)}`, { sha: commit, force: false });
    if (res.status === 422 || res.status === 409) throw new RefConflictError();
    await this.json(res, 'update ref');
  }
}
