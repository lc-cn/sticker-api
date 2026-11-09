import type { Snapshot } from './snapshot.js';

class NeedFile {
  constructor(readonly path: string) {}
}

/**
 * A's contract functions (planCreate, applyAssetChange, search …) take a *synchronous*
 * read(path). We run them against a lazily-filled view of one pinned commit: on a miss we
 * fetch the file from the snapshot and re-run the (pure) function. Bounded iterations.
 */
export async function withSyncRead<T>(snap: Snapshot, fn: (read: (p: string) => string | undefined) => T): Promise<{ value: T; seen: Map<string, string | undefined> }> {
  const seen = new Map<string, string | undefined>();
  for (let i = 0; i < 400; i++) {
    try {
      const value = fn((p) => {
        if (!seen.has(p)) throw new NeedFile(p);
        return seen.get(p);
      });
      return { value, seen };
    } catch (e) {
      if (!(e instanceof NeedFile)) throw e;
      const b = await snap.read(e.path);
      seen.set(e.path, b ? b.toString('utf8') : undefined);
    }
  }
  throw new Error('withSyncRead: too many files');
}
