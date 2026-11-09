import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { principalScope, type Principal } from '../auth/principal.js';
import { validateImage, DEFAULT_IMAGE_LIMITS, type ValidatedImage } from '../domain/image.js';
import { registry, type Catalog } from '../repo/contract.js';
import type { Snapshot } from '../repo/snapshot.js';
import { composeSvg, type LightTemplate, type Renderer } from '../render/renderer.js';
import type { AssetService } from './assets.js';
import { SlidingLimiter } from '../http/rate-limit.js';
import { fetchRemoteImage } from '../http/fetch-image.js';

/** Unauthenticated homepage visitor; identified only by (bucketed) client IP, never persisted. */
export type AnonymousPrincipal = { kind: 'anonymous'; ip: string };
export type RenderCaller = Principal | AnonymousPrincipal;

/** Plan §5: render inputs ≤1 MiB each, ≤2 MiB total; output ≤2 MiB. */
export const RENDER_IMAGE_MAX = 1024 * 1024;
export const RENDER_IMAGES_TOTAL_MAX = 2 * 1024 * 1024;
const OUTPUT_MAX = 2 * 1024 * 1024;

export type RenderInput = {
  template: string;
  version?: number;
  texts: string[];
  params: Record<string, unknown>;
  /** Multipart uploads, consumed in slot order when the matching imageUrls[i] is empty. */
  images: Buffer[];
  /**
   * Per-slot http(s) image URLs (SSRF-checked server fetch). Parallel to image slots:
   * a non-empty string at index i fills that slot; otherwise the next multipart upload is used.
   * Counts against the same render rate limit as uploads.
   */
  imageUrls: (string | null | undefined)[];
  assetIds: string[];
};

export class RenderService {
  private hits = new Map<string, number[]>();
  private readonly anon: SlidingLimiter;

  constructor(
    private readonly config: AppConfig,
    private readonly assets: AssetService,
    private readonly renderer: Renderer,
  ) {
    // Per-IP, per-instance (see SlidingLimiter); token principals keep the existing per-minute limit.
    this.anon = new SlidingLimiter([
      { limit: config.publicRenderPerMinute, ms: 60_000 },
      { limit: config.publicRenderPerDay, ms: 86_400_000 },
    ]);
  }

  private async catalogTemplates(snap: Snapshot) {
    const c = await snap.json<Catalog>('indexes/catalog.json');
    return (c?.templates ?? []).filter((t) => t.status === 'active');
  }

  private async load(snap: Snapshot, entry: { path: string }): Promise<{ t: LightTemplate; files: Map<string, Buffer> }> {
    const t = await snap.json<LightTemplate>(entry.path);
    if (!t || registry.validate('urn:sticker-assets:v1:template', t).length) {
      throw new AppError(503, 'template_invalid', 'Template definition in A fails schema');
    }
    const dir = entry.path.replace(/template\.json$/, '');
    const files = new Map<string, Buffer>();
    for (const f of t.files) {
      const b = await snap.read(dir + f.path, { metadata: false });
      if (!b || b.length !== f.bytes || createHash('sha256').update(b).digest('hex') !== f.sha256) {
        throw new AppError(503, 'template_asset_unverifiable', `Template asset ${f.path} missing or hash mismatch`);
      }
      files.set(f.path, b);
    }
    return { t, files };
  }

  private renderable(t: LightTemplate): { ok: boolean; reason: string | null } {
    if (t.renderer !== 'light-v1') return { ok: false, reason: 'unknown renderer' };
    if (t.output.mime !== 'image/png' || t.output.animated) return { ok: false, reason: 'animated/GIF output not supported in v1' };
    const missing = [...new Set(t.layers.filter((l) => l.type === 'text').map((l) => (l as { font: string }).font))].filter((f) => !this.renderer.hasFont(f));
    if (missing.length) return { ok: false, reason: `font not provisioned: ${missing.join(',')}` };
    return { ok: true, reason: null };
  }

  async list() {
    const snap = await this.assets.snapshot();
    const mirrors = await this.assets.mirrors(snap);
    const out = [];
    for (const e of await this.catalogTemplates(snap)) {
      const t = await snap.json<LightTemplate>(e.path);
      if (!t) continue;
      const r = this.renderable(t);
      // Thumbnail = the first image layer's file (template base image), pinned to this commit via mirrors.
      const base = t.layers.find((l) => l.type === 'image' && 'file' in l && typeof (l as { file?: unknown }).file === 'string') as { file: string } | undefined;
      const dir = e.path.replace(/template\.json$/, '');
      const preview = base ? this.assets.sources(snap.commit, dir + base.file, mirrors) : [];
      const description = typeof (t as { description?: unknown }).description === 'string'
        ? (t as { description: string }).description.slice(0, 120)
        : '';
      out.push({
        id: t.id, version: t.version, title: t.title, description,
        inputs: t.inputs, params: t.params, output: t.output,
        canvas: { width: t.canvas.width, height: t.canvas.height }, licenseIds: t.licenseIds,
        tags: (t as { tags?: string[] }).tags ?? [], preview,
        renderable: r.ok, unavailableReason: r.reason,
      });
    }
    return { commit: snap.commit, templates: out };
  }

  private rateLimit(p: RenderCaller) {
    if (p.kind === 'anonymous') {
      const wait = this.anon.take(`anon:${p.ip}`);
      if (wait !== null) {
        throw new AppError(429, 'rate_limited', 'Too many anonymous renders from this IP (per-instance limit)', { headers: { 'retry-after': String(wait) } });
      }
      return;
    }
    const key = principalScope(p);
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= this.config.renderPerMinute) {
      throw new AppError(429, 'rate_limited', 'Too many renders (per-instance limit)', { headers: { 'retry-after': '60' } });
    }
    arr.push(now);
    this.hits.set(key, arr);
  }

  async render(principal: RenderCaller, input: RenderInput): Promise<{ png: Buffer; template: string }> {
    if (!this.config.rendersEnabled) throw new AppError(503, 'renders_disabled', 'Rendering is temporarily disabled');
    this.rateLimit(principal);
    const snap = await this.assets.snapshot();
    const entries = (await this.catalogTemplates(snap)).filter((e) => e.id === input.template);
    const entry = input.version ? entries.find((e) => e.version === input.version) : entries.sort((a, b) => b.version - a.version)[0];
    if (!entry) throw new AppError(404, 'template_not_found', 'Unknown or disabled template');
    const { t, files } = await this.load(snap, entry);
    const r = this.renderable(t);
    if (!r.ok) throw new AppError(t.output.animated || t.output.mime !== 'image/png' ? 501 : 503, 'template_unavailable', r.reason!);

    // texts
    if (input.texts.length < t.inputs.texts.min || input.texts.length > t.inputs.texts.max) {
      throw new AppError(400, 'invalid_texts', `texts must have ${t.inputs.texts.min}..${t.inputs.texts.max} items`);
    }
    let total = 0;
    const texts = input.texts.map((s, i) => {
      if (typeof s !== 'string') throw new AppError(400, 'invalid_texts', `texts[${i}] must be a string`);
      const v = s.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if ([...v].length > t.inputs.texts.maxLength) throw new AppError(400, 'text_too_long', `texts[${i}] exceeds ${t.inputs.texts.maxLength}`);
      total += [...v].length;
      return v;
    });
    if (total > 200) throw new AppError(400, 'text_too_long', 'texts total must be ≤200 characters');

    // params: validated against the template schema; light-v1 has no layer bindings yet.
    const known = new Map(t.params.map((p) => [p.name, p]));
    for (const [k, v] of Object.entries(input.params)) {
      const spec = known.get(k);
      if (!spec) throw new AppError(400, 'invalid_params', `unknown param ${k}`);
      const ok =
        spec.type === 'enum' ? typeof v === 'string' && (spec.enum ?? []).includes(v)
        : spec.type === 'integer' ? Number.isInteger(v) && (spec.minimum === undefined || (v as number) >= spec.minimum) && (spec.maximum === undefined || (v as number) <= spec.maximum)
        : spec.type === 'boolean' ? typeof v === 'boolean'
        : typeof v === 'string' && v.length <= (spec.maxLength ?? 200);
      if (!ok) throw new AppError(400, 'invalid_params', `param ${k} invalid`);
    }

    // images: per-slot URL (SSRF-safe fetch) or next multipart upload, then assetIds
    if (input.imageUrls.length > t.inputs.images.max) {
      throw new AppError(400, 'invalid_images', `imageUrls must have at most ${t.inputs.images.max} items`);
    }
    const uploadQ = [...input.images];
    const slotBufs: Buffer[] = [];
    const slotCount = Math.max(t.inputs.images.max, input.imageUrls.length, uploadQ.length);
    for (let i = 0; i < slotCount && slotBufs.length < t.inputs.images.max; i++) {
      const raw = input.imageUrls[i];
      const url = typeof raw === 'string' ? raw.trim() : '';
      if (url) {
        slotBufs.push(await fetchRemoteImage(url));
      } else if (uploadQ.length) {
        slotBufs.push(uploadQ.shift()!);
      }
    }
    if (uploadQ.length) throw new AppError(400, 'invalid_images', 'too many uploaded images for the template slots');

    const images: ValidatedImage[] = [];
    let bytes = 0;
    for (const b of slotBufs) {
      if (b.length > RENDER_IMAGE_MAX) throw new AppError(413, 'payload_too_large', 'Each render image must be ≤1 MiB');
      bytes += b.length;
      images.push(validateImage(b, { ...DEFAULT_IMAGE_LIMITS, maxBytes: RENDER_IMAGE_MAX }));
    }
    if (bytes > RENDER_IMAGES_TOTAL_MAX) throw new AppError(413, 'payload_too_large', 'Render images must total ≤2 MiB');
    for (const id of input.assetIds) {
      const { bytes, record } = await this.assets.objectBytes(id);
      // Anonymous callers may only reference public (active, i.e. searchable) assets — not archived ones.
      if (principal.kind === 'anonymous' && record.status !== 'active') throw new AppError(404, 'not_found', 'Unknown asset id');
      images.push(validateImage(bytes));
    }
    if (images.length < t.inputs.images.min || images.length > t.inputs.images.max) {
      throw new AppError(400, 'invalid_images', `images must have ${t.inputs.images.min}..${t.inputs.images.max} items`);
    }

    const svg = composeSvg(t, files, texts, images, this.renderer.fonts);
    const fontIds = t.layers.filter((l, _i) => l.type === 'text' && texts[(l as { slot: number }).slot]).map((l) => (l as { font: string }).font);
    const png = await this.renderer.render(svg, fontIds);
    if (png.length > Math.min(OUTPUT_MAX, t.output.maxBytes)) throw new AppError(422, 'output_too_large', 'Rendered image exceeds output limit');
    return { png, template: `${t.id}@${t.version}` };
  }
}
