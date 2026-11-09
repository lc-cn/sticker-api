import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  storage_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  title TEXT,
  text_content TEXT,
  emotion TEXT,
  source_kind TEXT,
  source_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sticker_tags (
  sticker_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (sticker_id, tag),
  FOREIGN KEY (sticker_id) REFERENCES stickers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stickers_emotion ON stickers(emotion);
CREATE INDEX IF NOT EXISTS idx_stickers_created_at ON stickers(created_at);
CREATE INDEX IF NOT EXISTS idx_sticker_tags_tag ON sticker_tags(tag);
`,
  },
];

export function migrate(db: DatabaseSync): string[] {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => String((row as { id: string }).id)),
  );

  const newly: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      newly.push(migration.id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return newly;
}
