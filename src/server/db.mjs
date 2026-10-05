import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 5) throw new Error('Unsupported database schema');
    if (version < 1) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, CURRENT_TIMESTAMP); PRAGMA user_version=1');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (version < 2) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE collections (
            id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
            welcome TEXT, key_hash TEXT NOT NULL, credential_version INTEGER NOT NULL DEFAULT 1 CHECK(credential_version >= 1),
            expires_at TEXT NOT NULL, allowance INTEGER NOT NULL CHECK(typeof(allowance)='integer' AND allowance BETWEEN 0 AND 9007199254740991),
            revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE INDEX collections_created_idx ON collections(created_at DESC, id DESC);
          CREATE TABLE browser_sessions (
            token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
          );
          CREATE TABLE grants (
            id TEXT PRIMARY KEY, session_token_hash TEXT NOT NULL REFERENCES browser_sessions(token_hash),
            collection_id TEXT NOT NULL REFERENCES collections(id), credential_version INTEGER NOT NULL CHECK(credential_version >= 1),
            display_name TEXT NOT NULL, expires_at TEXT NOT NULL, UNIQUE(session_token_hash, collection_id)
          );
          CREATE INDEX grants_collection_idx ON grants(collection_id);
          CREATE TABLE uploads (
            id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), grant_id TEXT NOT NULL REFERENCES grants(id),
            original_name TEXT NOT NULL, storage_locator TEXT NOT NULL UNIQUE,
            declared_size INTEGER NOT NULL CHECK(typeof(declared_size)='integer' AND declared_size BETWEEN 0 AND 9007199254740991),
            status TEXT NOT NULL CHECK(status IN ('creating','uploading','finalizing','completed','deleting','cancelled')),
            error_code TEXT, deletion_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(deletion_confirmed IN (0,1)),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
            CHECK((status='completed')=(completed_at IS NOT NULL))
          );
          CREATE INDEX uploads_collection_status_idx ON uploads(collection_id,status);
          CREATE INDEX uploads_grant_idx ON uploads(grant_id);
          CREATE TRIGGER uploads_status_guard BEFORE UPDATE OF status ON uploads
          WHEN NOT (
            (OLD.status='creating' AND NEW.status IN ('uploading','deleting')) OR
            (OLD.status='uploading' AND NEW.status IN ('finalizing','deleting')) OR
            (OLD.status='finalizing' AND NEW.status='completed') OR
            (OLD.status='deleting' AND NEW.status='cancelled' AND NEW.deletion_confirmed=1)
          ) BEGIN SELECT RAISE(ABORT,'invalid upload transition'); END;
          CREATE TRIGGER uploads_owner_guard BEFORE INSERT ON uploads
          WHEN NOT EXISTS (SELECT 1 FROM grants WHERE id=NEW.grant_id AND collection_id=NEW.collection_id)
          BEGIN SELECT RAISE(ABORT,'upload grant ownership mismatch'); END;
          CREATE TRIGGER uploads_owner_update_guard BEFORE UPDATE OF grant_id,collection_id ON uploads
          WHEN NOT EXISTS (SELECT 1 FROM grants WHERE id=NEW.grant_id AND collection_id=NEW.collection_id)
          BEGIN SELECT RAISE(ABORT,'upload grant ownership mismatch'); END;
          CREATE TABLE admin_sessions (
            token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
          );
          INSERT INTO schema_migrations VALUES (2, CURRENT_TIMESTAMP);
          PRAGMA user_version=2;
        `);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (version < 3) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE guest_csrf (
            token_hash TEXT PRIMARY KEY REFERENCES browser_sessions(token_hash),
            secret TEXT NOT NULL
          );
          CREATE TABLE unlock_attempts (
            id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL,
            collection_id TEXT, source_ip TEXT, failed INTEGER NOT NULL CHECK(failed IN (0,1))
          );
          CREATE INDEX unlock_attempts_time_idx ON unlock_attempts(at_ms);
          CREATE INDEX unlock_attempts_collection_idx ON unlock_attempts(collection_id,at_ms);
          CREATE INDEX unlock_attempts_ip_idx ON unlock_attempts(collection_id,source_ip,failed,at_ms);
          CREATE TABLE unlock_buckets (
            collection_id TEXT NOT NULL, source_ip TEXT NOT NULL, last_at_ms INTEGER NOT NULL,
            PRIMARY KEY(collection_id,source_ip)
          );
          CREATE INDEX unlock_buckets_age_idx ON unlock_buckets(last_at_ms);
          INSERT INTO schema_migrations VALUES (3, CURRENT_TIMESTAMP);
          PRAGMA user_version=3;
        `);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (version < 4) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          ALTER TABLE uploads ADD COLUMN content_hash TEXT;
          ALTER TABLE uploads ADD COLUMN upload_metadata TEXT;
          CREATE INDEX uploads_recovery_idx ON uploads(status,id);
          INSERT INTO schema_migrations VALUES (4, CURRENT_TIMESTAMP);
          PRAGMA user_version=4;
        `);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (version < 5) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          ALTER TABLE uploads ADD COLUMN transfer_at TEXT;
          ALTER TABLE uploads ADD COLUMN deletion_intent INTEGER NOT NULL DEFAULT 0 CHECK(deletion_intent IN (0,1));
          ALTER TABLE uploads ADD COLUMN deleting_at TEXT;
          UPDATE uploads SET transfer_at=updated_at WHERE status IN ('creating','uploading','deleting');
          UPDATE uploads SET deleting_at=updated_at WHERE status='deleting';
          CREATE INDEX uploads_cleanup_idx ON uploads(status,transfer_at,id);
          CREATE TABLE cleanup_state (
            id INTEGER PRIMARY KEY CHECK(id=1), last_attempt_at TEXT, last_success_at TEXT,
            last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code)<=64)
          );
          INSERT INTO cleanup_state (id) VALUES (1);
          INSERT INTO schema_migrations VALUES (5, CURRENT_TIMESTAMP);
          PRAGMA user_version=5;
        `);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
