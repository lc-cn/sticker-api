/**
 * Local, in-memory fake of the GitHub endpoints sticker-api uses. Binds 127.0.0.1:0,
 * lives only for the duration of a test/smoke run. Never talks to the real GitHub.
 */
import { createHash, createVerify, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Commit = { tree: string; parents: string[]; message: string };
type Tree = Map<string, string>; // flat path → blob sha

const sha1 = (s: Buffer | string) => createHash('sha1').update(s).digest('hex');
const gitBlobSha = (b: Buffer) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));

export type FakeUser = { id: number; login: string };

export class FakeGitHub {
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, Tree>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  readonly calls: string[] = [];
  /** Called once just before a ref update is applied (e.g. to simulate a concurrent writer). */
  beforeRefUpdate: Array<() => void> = [];
  failRefUpdates = 0;
  rateLimitNext = 0;
  rawDown = false;
  apiDown = false;
  private server: http.Server | null = null;
  baseUrl = '';
  private codes = new Map<string, { challenge: string; user: FakeUser; redirectUri: string }>();
  private userTokens = new Map<string, FakeUser>();
  readonly revoked: string[] = [];
  readonly issuedInstallationTokens: string[] = [];
  /** Actions: recorded workflow_dispatch calls, fake runs, and a switch simulating a missing permission. */
  readonly dispatches: Array<{ workflow: string; body: { ref?: string; inputs?: Record<string, string> } }> = [];
  actionsForbidden = false;
  private runSeq = 0;

  constructor(
    readonly opts: {
      owner: string;
      repo: string;
      branch?: string;
      appId?: string;
      installationId?: string;
      appPublicKeyPem?: string;
      loginClientId?: string;
      loginClientSecret?: string;
    },
  ) {}

  get branch() {
    return this.opts.branch ?? 'main';
  }

  // ---------- git helpers ----------
  putTree(t: Tree): string {
    const sha = sha1(JSON.stringify([...t.entries()].sort()));
    this.trees.set(sha, new Map(t));
    return sha;
  }
  putCommit(c: Commit): string {
    const sha = sha1(JSON.stringify(c) + randomBytes(8).toString('hex'));
    this.commits.set(sha, c);
    return sha;
  }
  head(): string {
    return this.refs.get(this.branch)!;
  }
  treeAt(commit: string): Tree {
    return this.trees.get(this.commits.get(commit)!.tree)!;
  }
  fileAt(commit: string, path: string): Buffer | null {
    const b = this.treeAt(commit).get(path);
    return b ? this.blobs.get(b)! : null;
  }
  headFile(path: string): Buffer | null {
    return this.fileAt(this.head(), path);
  }
  headJson<T = any>(path: string): T | null {
    const b = this.headFile(path);
    return b ? (JSON.parse(b.toString('utf8')) as T) : null;
  }
  headPaths(): string[] {
    return [...this.treeAt(this.head()).keys()].sort();
  }
  isAncestor(anc: string, desc: string): boolean {
    const stack = [desc];
    const seen = new Set<string>();
    while (stack.length) {
      const c = stack.pop()!;
      if (c === anc) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(...(this.commits.get(c)?.parents ?? []));
    }
    return false;
  }
  /** Direct commit to the branch (seed / simulate another writer). null deletes. */
  commitFiles(files: Record<string, Buffer | string | null>, message = 'direct'): string {
    const parent = this.refs.get(this.branch);
    const t: Tree = parent ? new Map(this.treeAt(parent)) : new Map();
    for (const [p, v] of Object.entries(files)) {
      if (v === null) t.delete(p);
      else {
        const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
        const s = gitBlobSha(b);
        this.blobs.set(s, b);
        t.set(p, s);
      }
    }
    const sha = this.putCommit({ tree: this.putTree(t), parents: parent ? [parent] : [], message });
    this.refs.set(this.branch, sha);
    return sha;
  }

  // ---------- OAuth helpers ----------
  /** Simulates the user approving on github.com/login/oauth/authorize. */
  authorize(authorizeUrl: string, user: FakeUser): { code: string; state: string; redirectUri: string } {
    const u = new URL(authorizeUrl);
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required');
    if (u.searchParams.get('client_id') !== this.opts.loginClientId) throw new Error('bad client_id');
    const code = randomBytes(10).toString('hex');
    const redirectUri = u.searchParams.get('redirect_uri')!;
    this.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, user, redirectUri });
    return { code, state: u.searchParams.get('state')!, redirectUri };
  }

  // ---------- server ----------
  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          this.handle(req, res, Buffer.concat(chunks));
        } catch (e) {
          res.writeHead(500).end(String(e));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.baseUrl;
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  private send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    if (body === undefined) {
      res.writeHead(status, headers).end();
    } else if (Buffer.isBuffer(body)) {
      res.writeHead(status, { 'content-type': 'application/octet-stream', ...headers }).end(body);
    } else {
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    }
  }

  private verifyJwt(jwt: string): boolean {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s || !this.opts.appPublicKeyPem) return false;
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    if (!v.verify(this.opts.appPublicKeyPem, Buffer.from(s, 'base64url'))) return false;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    return payload.iss === this.opts.appId && payload.exp > now && payload.exp - payload.iat <= 600;
  }

  private authed(req: http.IncomingMessage): boolean {
    const a = req.headers.authorization ?? '';
    return this.issuedInstallationTokens.some((t) => a === `Bearer ${t}`);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname;
    const method = req.method!;
    this.calls.push(`${method} ${path}`);
    const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {});

    // OAuth (github.com)
    if (method === 'POST' && path === '/login/oauth/access_token') {
      const b = json();
      const entry = this.codes.get(b.code);
      this.codes.delete(b.code); // single use
      const challenge = createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url');
      if (!entry || b.client_id !== this.opts.loginClientId || b.client_secret !== this.opts.loginClientSecret || b.redirect_uri !== entry.redirectUri || challenge !== entry.challenge) {
        return this.send(res, 200, { error: 'bad_verification_code' });
      }
      const token = `ghu_${randomBytes(12).toString('hex')}`;
      this.userTokens.set(token, entry.user);
      return this.send(res, 200, { access_token: token, token_type: 'bearer', scope: '' });
    }
    if (method === 'GET' && path === '/user') {
      const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = this.userTokens.get(t);
      return u ? this.send(res, 200, { id: u.id, login: u.login }) : this.send(res, 401, { message: 'Bad credentials' });
    }
    if (method === 'DELETE' && path.startsWith('/applications/')) {
      const b = json();
      this.revoked.push(b.access_token);
      this.userTokens.delete(b.access_token);
      return this.send(res, 204);
    }

    // App installation token
    const inst = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === 'POST' && inst) {
      const jwt = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (inst[1] !== this.opts.installationId || !this.verifyJwt(jwt)) return this.send(res, 401, { message: 'bad jwt' });
      const b = json();
      if (JSON.stringify(b.repositories) !== JSON.stringify([this.opts.repo])) return this.send(res, 422, { message: 'bad repos' });
      const token = `ghs_${randomBytes(12).toString('hex')}`;
      this.issuedInstallationTokens.push(token);
      return this.send(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }

    // raw.githubusercontent.com
    const raw = /^\/raw\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(path);
    if (method === 'GET' && raw) {
      if (req.headers.authorization) return this.send(res, 400, { message: 'raw must not receive credentials' });
      if (this.rawDown) return this.send(res, 503);
      if (raw[1] !== this.opts.owner || raw[2] !== this.opts.repo || !this.commits.has(raw[3]!)) return this.send(res, 404);
      const b = this.fileAt(raw[3]!, decodeURIComponent(raw[4]!));
      return b ? this.send(res, 200, b) : this.send(res, 404);
    }

    // REST repo API
    const pre = `/repos/${this.opts.owner}/${this.opts.repo}`;
    if (!path.startsWith(pre + '/')) return this.send(res, 404, { message: 'Not Found' });
    if (this.apiDown) return this.send(res, 503);
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return this.send(res, 403, { message: 'secondary rate limit' }, { 'retry-after': '90' });
    }
    if (!this.authed(req)) return this.send(res, 401, { message: 'Requires authentication' });
    const sub = path.slice(pre.length);

    let wf: RegExpExecArray | null;
    if ((wf = /^\/actions\/workflows\/([^/]+)\/(dispatches|runs)$/.exec(sub))) {
      if (this.actionsForbidden) return this.send(res, 403, { message: 'Resource not accessible by integration' });
      const workflow = decodeURIComponent(wf[1]!);
      if (method === 'POST' && wf[2] === 'dispatches') {
        const b = json();
        if (b.ref !== this.branch || typeof b.inputs !== 'object') return this.send(res, 422, { message: 'bad dispatch' });
        this.dispatches.push({ workflow, body: b });
        return this.send(res, 204);
      }
      if (method === 'GET' && wf[2] === 'runs') {
        const runs = this.dispatches
          .filter((d) => d.workflow === workflow)
          .map((d, i) => ({
            id: 1000 + i, run_number: i + 1, display_title: `collect ${d.body.inputs?.source ?? ''}`, event: 'workflow_dispatch',
            status: i === this.dispatches.length - 1 ? 'queued' : 'completed', conclusion: i === this.dispatches.length - 1 ? null : 'skipped',
            created_at: new Date(Date.UTC(2026, 10, 9, 8, i)).toISOString(), updated_at: new Date().toISOString(),
            html_url: `https://github.com/${this.opts.owner}/${this.opts.repo}/actions/runs/${1000 + i}`,
          }))
          .reverse();
        this.runSeq = runs.length;
        return this.send(res, 200, { total_count: runs.length, workflow_runs: runs });
      }
    }

    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(sub))) {
      const sha = this.refs.get(decodeURIComponent(m[1]!));
      return sha ? this.send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }) : this.send(res, 404);
    }
    if (method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(sub))) {
      const c = this.commits.get(m[1]!);
      return c ? this.send(res, 200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : this.send(res, 404);
    }
    if (method === 'GET' && (m = /^\/contents\/(.+)$/.exec(sub))) {
      const ref = url.searchParams.get('ref')!;
      if (!this.commits.has(ref)) return this.send(res, 404);
      const b = this.fileAt(ref, decodeURIComponent(m[1]!));
      return b ? this.send(res, 200, b) : this.send(res, 404, { message: 'Not Found' });
    }
    if (method === 'POST' && sub === '/git/blobs') {
      const b = json();
      const buf = Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8');
      const sha = gitBlobSha(buf);
      this.blobs.set(sha, buf);
      return this.send(res, 201, { sha });
    }
    if (method === 'POST' && sub === '/git/trees') {
      const b = json();
      const base = b.base_tree ? this.trees.get(b.base_tree) : new Map();
      if (!base) return this.send(res, 422, { message: 'base_tree invalid' });
      const t: Tree = new Map(base);
      for (const e of b.tree as Array<{ path: string; sha: string | null; mode: string; type: string }>) {
        if (e.mode !== '100644' || e.type !== 'blob') return this.send(res, 422, { message: 'bad entry' });
        if (e.sha === null) t.delete(e.path);
        else if (!this.blobs.has(e.sha)) return this.send(res, 422, { message: 'unknown blob' });
        else t.set(e.path, e.sha);
      }
      return this.send(res, 201, { sha: this.putTree(t) });
    }
    if (method === 'POST' && sub === '/git/commits') {
      const b = json();
      if (!this.trees.has(b.tree) || !(b.parents as string[]).every((p) => this.commits.has(p))) return this.send(res, 422, { message: 'bad commit' });
      return this.send(res, 201, { sha: this.putCommit({ tree: b.tree, parents: b.parents, message: b.message }) });
    }
    if (method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(sub))) {
      const b = json();
      const hook = this.beforeRefUpdate.shift();
      if (hook) hook();
      if (this.failRefUpdates > 0) {
        this.failRefUpdates--;
        return this.send(res, 422, { message: 'Update is not a fast forward' });
      }
      const branch = decodeURIComponent(m[1]!);
      const cur = this.refs.get(branch)!;
      if (b.force !== false) return this.send(res, 400, { message: 'test requires force:false' });
      if (!this.commits.has(b.sha) || !this.isAncestor(cur, b.sha)) return this.send(res, 422, { message: 'Update is not a fast forward' });
      this.refs.set(branch, b.sha);
      return this.send(res, 200, { ref: `refs/heads/${branch}`, object: { sha: b.sha } });
    }
    return this.send(res, 404, { message: 'Not Found' });
  }
}
