import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { RefConflictError, type GitHubRepoClient, type TreeEntry } from '../github/client.js';
import { Snapshot } from './snapshot.js';

export type BuildOutcome<T> =
  | { kind: 'noop'; result: T }
  | { kind: 'commit'; files: Map<string, Buffer | null>; message: string; result: T };

export type PublishResult<T> = { commit: string | null; result: T; attempts: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * CONTRACT §4 atomic commit protocol:
 * GET ref H → read affected files pinned at H → blobs → tree(base_tree = H.tree) →
 * commit(parents=[H]) → PATCH ref force:false. On non-fast-forward: re-read the new HEAD and
 * rebuild from scratch (tombstones / budget / idempotency / revision are re-checked by `build`).
 * Never force, never reuse a tree built on an old HEAD.
 */
export class Publisher {
  constructor(
    private readonly gh: GitHubRepoClient,
    private readonly maxAttempts: number,
    private readonly onCommitted: (sha: string) => void,
    private readonly backoffMs = (attempt: number) => Math.min(1000, 50 * 2 ** attempt) * (0.5 + Math.random() / 2),
  ) {}

  async publish<T>(build: (snap: Snapshot, attempt: number) => Promise<BuildOutcome<T>>): Promise<PublishResult<T>> {
    const blobCache = new Map<string, string>(); // content sha256 → git blob sha (safe to reuse across attempts)
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const head = await this.gh.getHeadSha();
      const snap = new Snapshot(head, (c, p) => this.gh.readFileApi(c, p), null, 8 * 1024 * 1024);
      await snap.assertSupported();
      const outcome = await build(snap, attempt);
      if (outcome.kind === 'noop') {
        this.onCommitted(head);
        return { commit: null, result: outcome.result, attempts: attempt };
      }
      const { tree: baseTree } = await this.gh.getCommit(head);
      const entries: TreeEntry[] = [];
      for (const [path, content] of [...outcome.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (content === null) {
          entries.push({ path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        const key = createHash('sha256').update(content).digest('hex');
        let blob = blobCache.get(key);
        if (!blob) {
          blob = await this.gh.createBlob(content);
          blobCache.set(key, blob);
        }
        entries.push({ path, mode: '100644', type: 'blob', sha: blob });
      }
      const tree = await this.gh.createTree(baseTree, entries);
      const commit = await this.gh.createCommit(outcome.message, tree, [head]);
      try {
        await this.gh.updateRef(commit);
      } catch (err) {
        if (err instanceof RefConflictError) {
          if (attempt < this.maxAttempts) await sleep(this.backoffMs(attempt));
          continue;
        }
        throw err;
      }
      this.onCommitted(commit);
      return { commit, result: outcome.result, attempts: attempt };
    }
    throw new AppError(409, 'publish_conflict', 'A repo kept moving; retry the same request with the same Idempotency-Key', {
      retryable: true,
    });
  }
}
