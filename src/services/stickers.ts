import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.js';
import type {
  CreateStickerInput,
  SearchQuery,
  StickerRecord,
  UpdateStickerInput,
} from '../types.js';
import { detectImage } from './image.js';
import type { FileStorage } from './storage.js';

type StickerRow = {
  id: string;
  content_hash: string;
  storage_name: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  title: string | null;
  text_content: string | null;
  emotion: string | null;
  source_kind: string | null;
  source_note: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeTags(tags: string[] | undefined | null): string[] {
  if (!tags) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = String(raw).trim();
    if (!tag) continue;
    if (tag.length > 64) {
      throw new AppError(400, 'tag_too_long', 'Each tag must be <= 64 characters');
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length > 32) {
      throw new AppError(400, 'too_many_tags', 'At most 32 tags are allowed');
    }
  }
  return out;
}

function optionalText(value: string | null | undefined, field: string, max = 500): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new AppError(400, 'field_too_long', `${field} must be <= ${max} characters`);
  }
  return trimmed;
}

export class StickerService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly storage: FileStorage,
    private readonly maxUploadBytes: number,
    private readonly maxImageDimension: number,
  ) {}

  private tagsFor(id: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM sticker_tags WHERE sticker_id = ? ORDER BY tag COLLATE NOCASE')
      .all(id) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  private mapRow(row: StickerRow): StickerRecord {
    return {
      id: row.id,
      contentHash: row.content_hash,
      storageName: row.storage_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      width: row.width,
      height: row.height,
      title: row.title,
      textContent: row.text_content,
      emotion: row.emotion,
      sourceKind: row.source_kind,
      sourceNote: row.source_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: this.tagsFor(row.id),
    };
  }

  getById(id: string): StickerRecord {
    const row = this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined;
    if (!row) throw new AppError(404, 'not_found', 'Sticker not found');
    return this.mapRow(row);
  }

  async create(input: CreateStickerInput): Promise<{ sticker: StickerRecord; deduplicated: boolean }> {
    if (!input.buffer?.length) {
      throw new AppError(400, 'empty_file', 'Upload file is required');
    }
    if (input.buffer.length > this.maxUploadBytes) {
      throw new AppError(413, 'payload_too_large', `File exceeds max size of ${this.maxUploadBytes} bytes`);
    }

    const detected = detectImage(input.buffer, this.maxImageDimension);
    const contentHash = createHash('sha256').update(input.buffer).digest('hex');

    const existing = this.db
      .prepare('SELECT * FROM stickers WHERE content_hash = ?')
      .get(contentHash) as StickerRow | undefined;
    if (existing) {
      return { sticker: this.mapRow(existing), deduplicated: true };
    }

    const id = randomUUID();
    const storageName = `${id}.${detected.extension}`;
    const now = new Date().toISOString();
    const title = optionalText(input.title, 'title', 200);
    const textContent = optionalText(input.textContent, 'textContent', 2000);
    const emotion = optionalText(input.emotion, 'emotion', 64);
    const sourceKind = optionalText(input.sourceKind, 'sourceKind', 64);
    const sourceNote = optionalText(input.sourceNote, 'sourceNote', 200);
    const tags = normalizeTags(input.tags);

    // Identity fields intentionally unsupported: no user id, no chat text, no sender.
    await this.storage.writeExclusive(storageName, input.buffer);

    try {
      this.db.exec('BEGIN');
      this.db
        .prepare(
          `INSERT INTO stickers (
            id, content_hash, storage_name, mime_type, byte_size, width, height,
            title, text_content, emotion, source_kind, source_note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          contentHash,
          storageName,
          detected.mimeType,
          input.buffer.length,
          detected.width,
          detected.height,
          title,
          textContent,
          emotion,
          sourceKind,
          sourceNote,
          now,
          now,
        );

      const insertTag = this.db.prepare(
        'INSERT INTO sticker_tags (sticker_id, tag) VALUES (?, ?)',
      );
      for (const tag of tags) {
        insertTag.run(id, tag);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      await this.storage.remove(storageName);
      // unique race on content_hash
      const raced = this.db
        .prepare('SELECT * FROM stickers WHERE content_hash = ?')
        .get(contentHash) as StickerRow | undefined;
      if (raced) {
        return { sticker: this.mapRow(raced), deduplicated: true };
      }
      throw err;
    }

    return { sticker: this.getById(id), deduplicated: false };
  }

  search(query: SearchQuery): { items: StickerRecord[]; page: number; limit: number; total: number } {
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (query.emotion) {
      where.push('s.emotion = ?');
      params.push(query.emotion);
    }
    if (query.tag) {
      where.push('EXISTS (SELECT 1 FROM sticker_tags t WHERE t.sticker_id = s.id AND t.tag = ?)');
      params.push(query.tag);
    }
    if (query.q) {
      const like = `%${query.q}%`;
      where.push(
        `(IFNULL(s.title, '') LIKE ? OR IFNULL(s.text_content, '') LIKE ? OR IFNULL(s.emotion, '') LIKE ? OR EXISTS (SELECT 1 FROM sticker_tags t2 WHERE t2.sticker_id = s.id AND t2.tag LIKE ?))`,
      );
      params.push(like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM stickers s ${whereSql}`)
      .get(...params) as { c: number };
    const rows = this.db
      .prepare(
        `SELECT s.* FROM stickers s ${whereSql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as StickerRow[];

    return {
      items: rows.map((r) => this.mapRow(r)),
      page,
      limit,
      total: Number(totalRow.c) || 0,
    };
  }

  update(id: string, input: UpdateStickerInput): StickerRecord {
    const existing = this.getById(id);
    const now = new Date().toISOString();

    const title = input.title !== undefined ? optionalText(input.title, 'title', 200) : existing.title;
    const textContent =
      input.textContent !== undefined ? optionalText(input.textContent, 'textContent', 2000) : existing.textContent;
    const emotion =
      input.emotion !== undefined ? optionalText(input.emotion, 'emotion', 64) : existing.emotion;
    const sourceKind =
      input.sourceKind !== undefined ? optionalText(input.sourceKind, 'sourceKind', 64) : existing.sourceKind;
    const sourceNote =
      input.sourceNote !== undefined ? optionalText(input.sourceNote, 'sourceNote', 200) : existing.sourceNote;
    const tags = input.tags !== undefined && input.tags !== null ? normalizeTags(input.tags) : existing.tags;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE stickers SET title = ?, text_content = ?, emotion = ?, source_kind = ?, source_note = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(title, textContent, emotion, sourceKind, sourceNote, now, id);

      if (input.tags !== undefined) {
        this.db.prepare('DELETE FROM sticker_tags WHERE sticker_id = ?').run(id);
        const insertTag = this.db.prepare('INSERT INTO sticker_tags (sticker_id, tag) VALUES (?, ?)');
        for (const tag of tags) insertTag.run(id, tag);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getById(id);
  }

  async remove(id: string): Promise<void> {
    const existing = this.getById(id);
    this.db.prepare('DELETE FROM stickers WHERE id = ?').run(id);
    await this.storage.remove(existing.storageName);
  }

  async readFile(id: string): Promise<{ sticker: StickerRecord; buffer: Buffer }> {
    const sticker = this.getById(id);
    const buffer = await this.storage.read(sticker.storageName);
    return { sticker, buffer };
  }
}
