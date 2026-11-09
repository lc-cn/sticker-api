import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { GitHubRepoClient } from '../github/client.js';
import { SlidingLimiter } from '../http/rate-limit.js';
import type { AssetService } from './assets.js';

export type CollectSource = { id: string; label: string; approved: boolean; description: string };
type Registry = { schemaVersion: number; workflow?: string; sources?: unknown };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const short = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Admin-triggered collection: B only *dispatches* A's `collect.yml` (workflow_dispatch, input `source`) and
 * lists its recent runs. B never waits for the run. The source list is A's `config/collect-sources.json`
 * read at the current pinned commit. Cooldown is per source and per instance (in memory).
 */
export class CollectService {
  private readonly cooldown: SlidingLimiter;

  constructor(
    private readonly config: AppConfig,
    private readonly gh: GitHubRepoClient | null,
    private readonly assets: AssetService,
  ) {
    this.cooldown = new SlidingLimiter([{ limit: 1, ms: config.collectCooldownSeconds * 1000 }], 1000);
  }

  async sources(): Promise<{ commit: string; workflow: string; sources: CollectSource[] }> {
    const snap = await this.assets.snapshot();
    const reg = await snap.json<Registry>('config/collect-sources.json');
    const list = Array.isArray(reg?.sources) ? (reg!.sources as Array<Record<string, unknown>>) : [];
    const sources = list
      .filter((s) => typeof s.id === 'string' && ID_RE.test(s.id))
      .slice(0, 50)
      .map((s) => ({ id: s.id as string, label: short(s.label, 64) || (s.id as string), approved: s.approved === true, description: short(s.description, 300) }));
    return { commit: snap.commit, workflow: this.config.collectWorkflow, sources };
  }

  private client(): GitHubRepoClient {
    if (!this.gh || !this.config.repo) throw new AppError(503, 'repo_unconfigured', 'A repo not configured');
    return this.gh;
  }

  async trigger(body: unknown): Promise<{ dispatched: true; source: string; dryRun: boolean; workflow: string; runsUrl: string }> {
    const o = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'source' && k !== 'dryRun') throw new AppError(400, 'invalid_request', `body.${k}: unknown field`);
    if (typeof o.source !== 'string' || !ID_RE.test(o.source)) throw new AppError(400, 'invalid_request', 'source id required');
    if (o.dryRun !== undefined && typeof o.dryRun !== 'boolean') throw new AppError(400, 'invalid_request', 'dryRun must be boolean');
    const dryRun = o.dryRun ?? true;
    const gh = this.client();
    const { sources } = await this.sources();
    if (!sources.some((s) => s.id === o.source)) throw new AppError(404, 'unknown_source', 'Source not listed in A config/collect-sources.json');
    const wait = this.cooldown.take(`collect:${o.source}`);
    if (wait !== null) {
      throw new AppError(429, 'rate_limited', `This source was triggered recently; retry in ${wait}s (per-instance cooldown)`, { headers: { 'retry-after': String(wait) } });
    }
    try {
      await gh.dispatchWorkflow(this.config.collectWorkflow, this.config.repo!.branch, { source: o.source, dry_run: String(dryRun) });
    } catch (e) {
      this.cooldown.undo(`collect:${o.source}`); // a failed dispatch must not lock the source
      throw e;
    }
    return { dispatched: true, source: o.source, dryRun, workflow: this.config.collectWorkflow, runsUrl: this.runsUrl() };
  }

  private runsUrl() {
    const r = this.config.repo!;
    return `https://github.com/${r.owner}/${r.repo}/actions/workflows/${encodeURIComponent(this.config.collectWorkflow)}`;
  }

  async runs() {
    const gh = this.client();
    const raw = await gh.listWorkflowRuns(this.config.collectWorkflow, 10);
    const runs = raw.map((r) => ({
      id: typeof r.id === 'number' ? r.id : null,
      runNumber: typeof r.run_number === 'number' ? r.run_number : null,
      title: short(r.display_title, 200),
      event: short(r.event, 32),
      status: short(r.status, 32),
      conclusion: typeof r.conclusion === 'string' ? r.conclusion.slice(0, 32) : null,
      createdAt: short(r.created_at, 32),
      updatedAt: short(r.updated_at, 32),
      // Only ever link to github.com run pages.
      url: typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/') ? r.html_url : null,
    }));
    return { workflow: this.config.collectWorkflow, runsUrl: this.runsUrl(), runs };
  }
}
