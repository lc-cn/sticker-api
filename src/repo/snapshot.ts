import { AppError } from '../errors.js';

export type FileSource = (commit: string, path: string) => Promise<Buffer | null>;

/** Byte-bounded LRU for immutable (commit, path) → bytes. Per-instance only, not a global cache. */
export class LruBytes {
  private map = new Map<string, Buffer | null>();
  private size = 0;
  constructor(private readonly maxBytes: number) {}
  get(k: string): Buffer | null | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k)!;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k: string, v: Buffer | null): void {
    const len = v ? v.length : 0;
    if (len > this.maxBytes / 4) return;
    if (this.map.has(k)) this.size -= this.map.get(k)?.length ?? 0;
    this.map.set(k, v);
    this.size += len;
    while (this.size > this.maxBytes || this.map.size > 4096) {
      const [oldK, oldV] = this.map.entries().next().value as [string, Buffer | null];
      this.map.delete(oldK);
      this.size -= oldV?.length ?? 0;
    }
  }
}

export const REPO_MARKER = 'sticker-assets.json';
export const SUPPORTED = { format: 'sticker-assets', schemaVersion: 1, indexFormat: 1, tokenizer: 'zh-bigram-v1' } as const;

/**
 * All reads for one logical request are pinned to a single commit H, so manifest / index /
 * object paths never mix states (plan §2 读一致性). Metadata reads are budgeted per request.
 */
export class Snapshot {
  private readBytes = 0;
  private inflight = new Map<string, Promise<Buffer | null>>();

  constructor(
    readonly commit: string,
    private readonly source: FileSource,
    private readonly cache: LruBytes | null,
    private readonly metadataBudgetBytes = 512 * 1024,
  ) {}

  get bytesRead() {
    return this.readBytes;
  }

  async read(path: string, opts: { metadata?: boolean } = { metadata: true }): Promise<Buffer | null> {
    const key = `${this.commit}:${path}`;
    let buf = this.cache?.get(key);
    if (buf === undefined) {
      let p = this.inflight.get(key);
      if (!p) {
        p = this.source(this.commit, path);
        this.inflight.set(key, p);
      }
      buf = await p;
      this.inflight.delete(key);
      if (opts.metadata !== false) this.cache?.set(key, buf);
    }
    if (opts.metadata !== false && buf) {
      this.readBytes += buf.length;
      if (this.readBytes > this.metadataBudgetBytes) {
        throw new AppError(503, 'read_budget_exceeded', 'Query exceeded metadata read budget', { retryable: false });
      }
    }
    return buf;
  }

  async json<T>(path: string): Promise<T | null> {
    const b = await this.read(path);
    if (!b) return null;
    try {
      return JSON.parse(b.toString('utf8')) as T;
    } catch {
      throw new AppError(503, 'repo_corrupt', `A file is not valid JSON: ${path}`);
    }
  }

  /** Fail closed on unknown schema/index/tokenizer versions (CONTRACT §0). */
  async assertSupported(): Promise<void> {
    const m = await this.json<Record<string, unknown>>(REPO_MARKER);
    if (
      !m ||
      m.format !== SUPPORTED.format ||
      m.schemaVersion !== SUPPORTED.schemaVersion ||
      m.indexFormat !== SUPPORTED.indexFormat ||
      m.tokenizer !== SUPPORTED.tokenizer
    ) {
      throw new AppError(503, 'repo_schema_unsupported', 'A repo schema/index version is unknown; refusing to serve or write');
    }
  }
}
