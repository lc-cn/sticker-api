/**
 * Small fixed-capacity sliding-window limiter. IN MEMORY, PER PROCESS: on Vercel every warm function
 * instance keeps its own counters, so the effective global limit is (limit × live instances). Good enough
 * as abuse damping for v1; a global quota would need shared storage (KV/D1), deliberately not used here.
 */
export type Window = { limit: number; ms: number };

export class SlidingLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly windows: Window[],
    private readonly maxKeys = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns null, or returns seconds until the next allowed hit (nothing recorded). */
  take(key: string): number | null {
    const t = this.now();
    const longest = Math.max(...this.windows.map((w) => w.ms));
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < longest);
    for (const w of this.windows) {
      const inWin = arr.filter((x) => t - x < w.ms);
      if (inWin.length >= w.limit) {
        const oldest = inWin[inWin.length - w.limit]!;
        return Math.max(1, Math.ceil((oldest + w.ms - t) / 1000));
      }
    }
    arr.push(t);
    this.hits.delete(key); // re-insert → Map order approximates LRU for eviction
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first !== undefined) this.hits.delete(first);
    }
    return null;
  }

  /** Forget the most recent hit for key (e.g. the guarded upstream call failed). */
  undo(key: string): void {
    const arr = this.hits.get(key);
    if (arr?.length) arr.pop();
  }
}
