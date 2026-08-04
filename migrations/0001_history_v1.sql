PRAGMA foreign_keys = ON;

CREATE TABLE history_collection_runs (
  bucket_start_ms INTEGER PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'complete', 'partial', 'failed')),
  error_code TEXT
) WITHOUT ROWID;

CREATE TABLE history_snapshots (
  resolution_minutes INTEGER NOT NULL CHECK (resolution_minutes IN (15, 60, 1440)),
  bucket_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  collected_at_ms INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  codec TEXT NOT NULL CHECK (codec = 'gzip-json-v1'),
  payload BLOB NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0 AND payload_bytes < 2000000),
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes > 0),
  content_sha256 TEXT NOT NULL,
  expected_samples INTEGER NOT NULL CHECK (expected_samples > 0),
  collected_samples INTEGER NOT NULL CHECK (collected_samples BETWEEN 0 AND expected_samples),
  source_status_json TEXT NOT NULL CHECK (json_valid(source_status_json)),
  gaps_json TEXT NOT NULL CHECK (json_valid(gaps_json)),
  PRIMARY KEY (resolution_minutes, bucket_start_ms),
  CHECK (period_end_ms > bucket_start_ms)
) WITHOUT ROWID;

CREATE INDEX history_snapshots_time
  ON history_snapshots(bucket_start_ms, resolution_minutes);
