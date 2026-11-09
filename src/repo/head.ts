import { AppError } from '../errors.js';

/**
 * Bounded-staleness HEAD cache (plan §6): refresh after ttl; if refresh fails and the cached
 * HEAD is older than maxStale, fail with 503 instead of serving possibly-deleted content.
 */
export class HeadCache {
  private sha: string | null = null;
  private fetchedAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly fetchHead: () => Promise<string>,
    private readonly ttlMs: number,
    private readonly maxStaleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    const age = this.now() - this.fetchedAt;
    if (this.sha && age < this.ttlMs) return this.sha;
    try {
      if (!this.inflight) {
        this.inflight = this.fetchHead().finally(() => {
          this.inflight = null;
        });
      }
      const sha = await this.inflight;
      this.set(sha);
      return sha;
    } catch (err) {
      if (this.sha && this.now() - this.fetchedAt < this.maxStaleMs) return this.sha;
      if (err instanceof AppError && err.code === 'upstream_rate_limited') throw err;
      throw new AppError(503, 'state_unverifiable', 'Current asset state cannot be verified right now', { retryable: true });
    }
  }

  set(sha: string): void {
    this.sha = sha;
    this.fetchedAt = this.now();
  }
}
