import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { Busboy } from '@fastify/busboy';
import { AppError } from '../errors.js';

/** Plan §5: whole multipart request ≤3 MiB, counted on actual bytes (Content-Length is not trusted). */
export const MAX_MULTIPART_BYTES = 3 * 1024 * 1024;
/** text/metadata fields total ≤16 KiB */
export const MAX_FIELDS_BYTES = 16 * 1024;

export type MultipartFile = { field: string; bytes: Buffer; declaredType: string };
export type MultipartBody = { kind: 'multipart'; files: MultipartFile[]; fields: Record<string, string[]> };

export async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > limit) {
      stream.destroy();
      throw new AppError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export function parseMultipart(
  body: Buffer,
  headers: IncomingHttpHeaders,
  opts: { maxFiles: number; maxFileBytes: number; maxTotalFileBytes: number; allowedFileFields: string[] },
): Promise<MultipartBody> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({
        headers: headers as { 'content-type': string } & IncomingHttpHeaders,
        limits: { files: opts.maxFiles, fileSize: opts.maxFileBytes, fields: 32, fieldSize: MAX_FIELDS_BYTES, parts: opts.maxFiles + 32, headerPairs: 20 },
      });
    } catch {
      reject(new AppError(400, 'invalid_multipart', 'Malformed multipart request'));
      return;
    }
    const files: MultipartFile[] = [];
    const fields: Record<string, string[]> = {};
    let fieldBytes = 0;
    let fileBytes = 0;
    let failed: AppError | null = null;
    const fail = (e: AppError) => {
      if (!failed) failed = e;
    };
    const pending: Promise<void>[] = [];
    bb.on('file', (field, stream, _filename, _enc, mime) => {
      if (!opts.allowedFileFields.includes(field)) {
        fail(new AppError(400, 'invalid_field', `Unexpected file field "${field}"`));
        stream.resume();
        return;
      }
      pending.push(
        (async () => {
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(c as Buffer);
          if ((stream as unknown as { truncated?: boolean }).truncated) {
            fail(new AppError(413, 'payload_too_large', `Each image must be ≤ ${opts.maxFileBytes} bytes`));
            return;
          }
          const bytes = Buffer.concat(chunks);
          fileBytes += bytes.length;
          if (fileBytes > opts.maxTotalFileBytes) fail(new AppError(413, 'payload_too_large', `Images total must be ≤ ${opts.maxTotalFileBytes} bytes`));
          files.push({ field, bytes, declaredType: mime });
        })(),
      );
    });
    bb.on('field', (name, value, nameTrunc, valTrunc) => {
      fieldBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (nameTrunc || valTrunc || fieldBytes > MAX_FIELDS_BYTES) {
        fail(new AppError(413, 'fields_too_large', `Text/metadata fields must total ≤ ${MAX_FIELDS_BYTES} bytes`));
        return;
      }
      (fields[name] ??= []).push(value);
    });
    bb.on('filesLimit', () => fail(new AppError(400, 'too_many_files', `At most ${opts.maxFiles} file(s)`)));
    bb.on('fieldsLimit', () => fail(new AppError(400, 'too_many_fields', 'Too many fields')));
    bb.on('partsLimit', () => fail(new AppError(400, 'too_many_parts', 'Too many parts')));
    bb.on('error', () => fail(new AppError(400, 'invalid_multipart', 'Malformed multipart request')));
    bb.on('finish', () => {
      Promise.all(pending).then(() => {
        if (failed) reject(failed);
        else resolve({ kind: 'multipart', files, fields });
      }, reject);
    });
    bb.end(body);
  });
}
