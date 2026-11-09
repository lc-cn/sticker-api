import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';

export class FileStorage {
  constructor(private readonly stickersDir: string) {}

  async ensureReady(): Promise<void> {
    await fsp.mkdir(this.stickersDir, { recursive: true });
    // probe write
    const probe = path.join(this.stickersDir, '.write-probe');
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
  }

  absolutePath(storageName: string): string {
    if (!storageName || storageName.includes('..') || storageName.includes('/') || storageName.includes('\\')) {
      throw new AppError(400, 'invalid_storage_name', 'Invalid storage name');
    }
    const full = path.join(this.stickersDir, storageName);
    const resolved = path.resolve(full);
    const root = path.resolve(this.stickersDir);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new AppError(400, 'path_traversal', 'Refusing path outside stickers directory');
    }
    return resolved;
  }

  async writeExclusive(storageName: string, buffer: Buffer): Promise<void> {
    const full = this.absolutePath(storageName);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const fh = await fsp.open(full, 'wx');
    try {
      await fh.writeFile(buffer);
    } finally {
      await fh.close();
    }
  }

  async read(storageName: string): Promise<Buffer> {
    const full = this.absolutePath(storageName);
    try {
      return await fsp.readFile(full);
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        throw new AppError(404, 'file_missing', 'Sticker file is missing on disk');
      }
      throw err;
    }
  }

  async remove(storageName: string): Promise<void> {
    const full = this.absolutePath(storageName);
    try {
      await fsp.unlink(full);
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  }

  existsSync(storageName: string): boolean {
    return fs.existsSync(this.absolutePath(storageName));
  }
}
