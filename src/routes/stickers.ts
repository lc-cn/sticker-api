import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import type { StickerService } from '../services/stickers.js';

function parseTagsField(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  const text = String(raw).trim();
  if (!text) return undefined;
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('not array');
      return parsed.map(String);
    } catch {
      throw new AppError(400, 'invalid_tags', 'tags JSON must be an array of strings');
    }
  }
  return text.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
}

function publicSticker(sticker: Awaited<ReturnType<StickerService['getById']>>) {
  return {
    id: sticker.id,
    contentHash: sticker.contentHash,
    mimeType: sticker.mimeType,
    byteSize: sticker.byteSize,
    width: sticker.width,
    height: sticker.height,
    title: sticker.title,
    textContent: sticker.textContent,
    emotion: sticker.emotion,
    sourceKind: sticker.sourceKind,
    sourceNote: sticker.sourceNote,
    createdAt: sticker.createdAt,
    updatedAt: sticker.updatedAt,
    tags: sticker.tags,
  };
}

export async function registerStickerRoutes(
  app: FastifyInstance,
  deps: { stickers: StickerService; maxUploadBytes: number },
): Promise<void> {
  app.post('/v1/stickers', async (request, reply) => {
    let fileBuffer: Buffer | null = null;
    const fields: Record<string, string> = {};

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') {
          throw new AppError(400, 'invalid_field', 'Only multipart field name "file" is accepted for binaries');
        }
        if (fileBuffer) {
          throw new AppError(400, 'too_many_files', 'Only one file is allowed');
        }
        fileBuffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }

    if (!fileBuffer) {
      throw new AppError(400, 'empty_file', 'multipart field "file" is required');
    }

    const result = await deps.stickers.create({
      buffer: fileBuffer,
      title: fields.title,
      textContent: fields.textContent ?? fields.text,
      emotion: fields.emotion,
      tags: parseTagsField(fields.tags),
      sourceKind: fields.sourceKind,
      sourceNote: fields.sourceNote,
    });

    return reply.code(result.deduplicated ? 200 : 201).send({
      deduplicated: result.deduplicated,
      sticker: publicSticker(result.sticker),
    });
  });

  app.get('/v1/stickers', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = Number.parseInt(query.page ?? '1', 10) || 1;
    const limit = Number.parseInt(query.limit ?? '20', 10) || 20;
    if (limit > 100) {
      throw new AppError(400, 'limit_too_large', 'limit must be <= 100');
    }
    const result = deps.stickers.search({
      q: query.q?.trim() || undefined,
      emotion: query.emotion?.trim() || undefined,
      tag: query.tag?.trim() || undefined,
      page,
      limit,
    });
    return {
      page: result.page,
      limit: result.limit,
      total: result.total,
      items: result.items.map(publicSticker),
    };
  });

  app.get('/v1/stickers/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { sticker: publicSticker(deps.stickers.getById(id)) };
  });

  app.patch('/v1/stickers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tags =
      body.tags === undefined
        ? undefined
        : Array.isArray(body.tags)
          ? body.tags.map(String)
          : (() => {
              throw new AppError(400, 'invalid_tags', 'tags must be an array of strings');
            })();

    const sticker = deps.stickers.update(id, {
      title: body.title === undefined ? undefined : (body.title as string | null),
      textContent: body.textContent === undefined ? undefined : (body.textContent as string | null),
      emotion: body.emotion === undefined ? undefined : (body.emotion as string | null),
      sourceKind: body.sourceKind === undefined ? undefined : (body.sourceKind as string | null),
      sourceNote: body.sourceNote === undefined ? undefined : (body.sourceNote as string | null),
      tags,
    });
    return { sticker: publicSticker(sticker) };
  });

  app.delete('/v1/stickers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await deps.stickers.remove(id);
    return reply.code(204).send();
  });

  app.get('/v1/stickers/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { sticker, buffer } = await deps.stickers.readFile(id);
    const etag = `"${sticker.contentHash}"`;
    const inm = request.headers['if-none-match'];
    if (inm && inm === etag) {
      return reply.code(304).header('ETag', etag).send();
    }
    return reply
      .header('Content-Type', sticker.mimeType)
      .header('Content-Length', buffer.length)
      .header('ETag', etag)
      .header('Cache-Control', 'private, max-age=60')
      .header('X-Content-Type-Options', 'nosniff')
      .send(buffer);
  });
}
