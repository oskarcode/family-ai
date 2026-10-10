-- Enforce relationships for document lifecycle records in D1/SQLite.
PRAGMA foreign_keys = ON;

-- Canonical document metadata, classification, approval, and lifecycle status.
CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY,
  source_local_path TEXT NOT NULL,
  source_checksum TEXT,
  source_size_bytes INTEGER NOT NULL,
  extension TEXT NOT NULL,
  mime_type TEXT,
  category TEXT NOT NULL,
  subcategory TEXT,
  doc_type TEXT NOT NULL,
  year TEXT NOT NULL,
  person TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  classification_confidence REAL,
  approved_by_user INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Storage locations and lineage for each persisted version of a document.
CREATE TABLE IF NOT EXISTS document_versions (
  version_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  r2_raw_bucket TEXT,
  r2_raw_key TEXT,
  r2_index_bucket TEXT,
  r2_index_key TEXT,
  r2_processed_bucket TEXT,
  r2_processed_key TEXT,
  lineage_parent_doc_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,
  FOREIGN KEY (lineage_parent_doc_id) REFERENCES documents(doc_id) ON DELETE SET NULL
);

-- Processing attempts and errors across asynchronous document pipeline stages.
CREATE TABLE IF NOT EXISTS processing_jobs (
  job_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  job_status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  payload_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);

-- AI Search indexing requests and their latest reported outcomes.
CREATE TABLE IF NOT EXISTS index_events (
  event_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  index_target TEXT NOT NULL,
  index_status TEXT NOT NULL,
  request_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);

-- Searchable access-control metadata attached to individual documents.
CREATE TABLE IF NOT EXISTS access_tags (
  tag_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  tag_key TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
);

-- Lookup indexes support common lifecycle, classification, ownership, and access filters.
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_documents_person ON documents(person);
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(year);
CREATE INDEX IF NOT EXISTS idx_documents_sensitivity ON documents(sensitivity);
-- Relationship indexes accelerate document history and pipeline-status joins.
CREATE INDEX IF NOT EXISTS idx_document_versions_doc_id ON document_versions(doc_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_doc_stage ON processing_jobs(doc_id, stage);
CREATE INDEX IF NOT EXISTS idx_index_events_doc ON index_events(doc_id);
CREATE INDEX IF NOT EXISTS idx_access_tags_doc ON access_tags(doc_id);
