// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// THE SCHEMA — the contract, as statements the app runs at startup
// =============================================================================
//
// Every statement below is the Discord Dashboard database contract (schema
// version 1), verbatim and in order. All of them are idempotent, so running
// the list on every connect is the whole migration story: a fresh database
// gets the tables, an existing one gets nothing.
//
// ONE STATEMENT PER `execute`. The `execute` tool takes a single statement —
// it is one SQLAlchemy `text()` clause, not a script — so the file is an ARRAY
// rather than one blob, and `ensureSchema` sends them one at a time, in order.
//
// WHO WRITES WHAT. `dd_events` is written SERVER-SIDE, by the discord node
// (`captureEvents`); `slack_page` rows exist only from the task-log import. The app
// never inserts into it and never deletes from it — it reads `seq > $last`.
// Everything below `dd_events` is the app's, through fixed parameterized SQL
// in `src/db/repo.ts`.
// =============================================================================

/**
 * The schema, statement by statement.
 *
 * Copied from the contract file; the comments that document the columns are
 * kept with the statements they belong to, because the column semantics are
 * the only place the `event_key` rules are written down.
 */
export const SCHEMA_STATEMENTS: string[] = [
	// ---------------------------------------------------------------------
	// dd_events: append-only capture log. Written SERVER-SIDE by the discord
	// node (opt-in `captureEvents`); `source` is its `captureSource` label.
	// slack_page rows come only from the task-log import — a live page is read
	// from the escalation (see src/db/fold.ts). Never updated, never deleted by
	// the app. A duplicate delivery is ignored by the unique key.
	//
	// event_key rules:
	//   message    : ''            (a retried text pass: 'retry:<n>')
	//   outbound   : ''            (the reply message ids live in payload.messageIds)
	//   no_reply   : <reason>
	//   reaction   : '<userId>:<emoji>:<add|remove>:<occurred_at epoch ms>'
	//   slack_page : ''            (message_id = the Discord message being answered)
	// ---------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS dd_events (
  seq          BIGSERIAL PRIMARY KEY,
  event_type   TEXT        NOT NULL,
  message_id   TEXT        NOT NULL,
  event_key    TEXT        NOT NULL DEFAULT '',
  thread_id    TEXT,
  channel_id   TEXT,
  guild_id     TEXT,
  author_id    TEXT,
  author_is_bot BOOLEAN,
  occurred_at  TIMESTAMPTZ NOT NULL,
  text         TEXT,
  payload      JSONB       NOT NULL,
  source       TEXT        NOT NULL DEFAULT '',
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dd_events_dedupe UNIQUE (message_id, event_type, event_key)
)`,
	`CREATE INDEX IF NOT EXISTS dd_events_thread ON dd_events (thread_id)`,
	`CREATE INDEX IF NOT EXISTS dd_events_occurred ON dd_events (occurred_at)`,

	// ---------------------------------------------------------------------
	// One row per settings slice ('discord', 'behavior', 'pipeline',
	// 'advanced', 'eval'). Optimistic concurrency:
	// UPDATE ... SET version = version + 1 WHERE slice = $1 AND version = $2.
	// ---------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS dd_settings (
  slice       TEXT PRIMARY KEY,
  value       JSONB       NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  updated_by  TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

	// Eval state per thread (mirrors the reference store's `threads` columns).
	`CREATE TABLE IF NOT EXISTS dd_threads (
  thread_id        TEXT PRIMARY KEY,
  eval_status      TEXT NOT NULL DEFAULT 'open',
  outcome          TEXT,
  outcome_source   TEXT,
  cause            TEXT,
  cause_source     TEXT,
  excluded_reason  TEXT,
  cluster_id       TEXT,
  q_top_score      DOUBLE PRECISION,
  a_top_score      DOUBLE PRECISION,
  grader_json      JSONB,
  qa_draft         JSONB,
  graded_at        TIMESTAMPTZ,
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  dismissed        BOOLEAN NOT NULL DEFAULT false,
  replay           BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

	// Audit trail of every review action (append-only).
	`CREATE TABLE IF NOT EXISTS dd_reviews (
  id         BIGSERIAL PRIMARY KEY,
  thread_id  TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  fields     JSONB       NOT NULL DEFAULT '{}',
  reviewer   TEXT        NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
	`CREATE INDEX IF NOT EXISTS dd_reviews_thread ON dd_reviews (thread_id)`,

	`CREATE TABLE IF NOT EXISTS dd_clusters (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

	// Teach Ralph: approved canonical Q/A, guarded by ingested_at.
	`CREATE TABLE IF NOT EXISTS dd_qa_pairs (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     TEXT,
  question      TEXT        NOT NULL,
  answer        TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'approved',
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  ingested_at   TIMESTAMPTZ,
  kb_object_id  TEXT,
  kb_document   TEXT
)`,
	`CREATE INDEX IF NOT EXISTS dd_qa_pairs_thread ON dd_qa_pairs (thread_id)`,

	`CREATE TABLE IF NOT EXISTS dd_golden_cases (
  id             TEXT PRIMARY KEY,
  question       TEXT        NOT NULL,
  expected       TEXT        NOT NULL,
  golden_answer  TEXT,
  source         TEXT        NOT NULL,
  thread_id      TEXT,
  active         BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

	`CREATE TABLE IF NOT EXISTS dd_replay_runs (
  id               BIGSERIAL PRIMARY KEY,
  file_name        TEXT        NOT NULL,
  imported         BOOLEAN     NOT NULL DEFAULT false,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  n                INTEGER,
  passed           INTEGER,
  hard_fails       INTEGER,
  regressions      JSONB       NOT NULL DEFAULT '[]',
  copy_project_id  TEXT,
  stopped_early    BOOLEAN     NOT NULL DEFAULT false
)`,

	`CREATE TABLE IF NOT EXISTS dd_replay_results (
  run_id     BIGINT NOT NULL REFERENCES dd_replay_runs(id) ON DELETE CASCADE,
  case_id    TEXT   NOT NULL,
  ord        INTEGER NOT NULL DEFAULT 0,
  question   TEXT   NOT NULL DEFAULT '',
  status     TEXT   NOT NULL,
  verdict    TEXT   NOT NULL DEFAULT '',
  notes      TEXT   NOT NULL DEFAULT '',
  reply      TEXT,
  escalated  BOOLEAN,
  retried    BOOLEAN,
  PRIMARY KEY (run_id, case_id)
)`,

	// ---------------------------------------------------------------------
	// The Knowledge screen's catalog: one row per document in Ralph's
	// knowledge base (the Chroma collection). The store nodes cannot list a
	// collection, so this is the list. `content` is the full text that was
	// sent, so reading a document does not depend on the vector store.
	//   source corpus   : a docs page, seeded once (route set)
	//   source taught   : a Teach Ralph answer, written when it lands
	//   source uploaded : a document added on the Knowledge screen
	// ---------------------------------------------------------------------
	`CREATE TABLE IF NOT EXISTS dd_kb_documents (
  object_id  TEXT PRIMARY KEY,
  name       TEXT        NOT NULL,
  title      TEXT        NOT NULL DEFAULT '',
  source     TEXT        NOT NULL CHECK (source IN ('corpus', 'taught', 'uploaded')),
  route      TEXT,
  content    TEXT        NOT NULL DEFAULT '',
  chars      INTEGER     NOT NULL DEFAULT 0,
  added_by   TEXT,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)`,

	// Small key/value facts: 'schema_version' = '1', 'last_graded_at' = ISO
	// time, 'migrated_from_workspace' = ISO time.
	`CREATE TABLE IF NOT EXISTS dd_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
)`,
	`INSERT INTO dd_meta (key, value) VALUES ('schema_version', '1') ON CONFLICT (key) DO NOTHING`,
];

/**
 * Run the schema, one statement at a time.
 *
 * Sequential on purpose: `dd_replay_results` has a foreign key onto
 * `dd_replay_runs`, and the indexes name the tables they are on. A parallel
 * send would be racing its own dependencies for no gain — the whole list is a
 * handful of round trips against a database that already has the tables.
 *
 * @param exec - The gateway's `execute` call.
 */
export async function ensureSchema(exec: (sql: string, params?: unknown[]) => Promise<unknown>): Promise<void> {
	for (const statement of SCHEMA_STATEMENTS) await exec(statement);
}
