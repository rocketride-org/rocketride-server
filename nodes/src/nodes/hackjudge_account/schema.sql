-- Hack Judge shared schema: every table the hackjudge_* DB nodes touch.
-- Idempotent: safe to run repeatedly (CREATE IF NOT EXISTS throughout).
--
-- Apply with:  psql "$HACKJUDGE_DATABASE_URL" -f schema.sql
--
-- The same file ships with hackjudge_account, hackjudge_store and
-- hackjudge_tokens so each PR is self-contained; the three copies are
-- identical and must stay in sync.

CREATE TABLE IF NOT EXISTS tenants (
    id                 VARCHAR(32)  PRIMARY KEY,
    name               VARCHAR(200) NOT NULL,
    tier               VARCHAR(20)  NOT NULL DEFAULT 'developer',
    marketplace_org_id VARCHAR(200),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- required: hackjudge_account's first-sight creation is INSERT ... ON CONFLICT
-- (marketplace_org_id), which needs this unique index to converge concurrent
-- requests onto one tenant row
CREATE UNIQUE INDEX IF NOT EXISTS tenants_marketplace_org_id_key
    ON tenants (marketplace_org_id);

CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(32)  PRIMARY KEY,
    external_id   VARCHAR(200) NOT NULL,
    tenant_id     VARCHAR(32)  NOT NULL REFERENCES tenants (id),
    name          VARCHAR(200) NOT NULL DEFAULT '',
    email         VARCHAR(320) NOT NULL DEFAULT '',
    role          VARCHAR(40)  NOT NULL DEFAULT 'member',
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- required: same ON CONFLICT convergence for concurrent first sign-ins
CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_key ON users (external_id);
CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users (tenant_id);

CREATE TABLE IF NOT EXISTS targets (
    id         VARCHAR(32)  PRIMARY KEY,
    tenant_id  VARCHAR(32)  NOT NULL REFERENCES tenants (id),
    slug       VARCHAR(200) NOT NULL,
    name       VARCHAR(200) NOT NULL,
    config     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    is_preset  BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS targets_tenant_id_idx ON targets (tenant_id);

CREATE TABLE IF NOT EXISTS runs (
    id              VARCHAR(32)  PRIMARY KEY,
    tenant_id       VARCHAR(32)  NOT NULL REFERENCES tenants (id),
    target_id       VARCHAR(32)  REFERENCES targets (id),
    name            VARCHAR(200) NOT NULL,
    event_date      VARCHAR(10),
    history_penalty DOUBLE PRECISION,
    status          VARCHAR(20)  NOT NULL DEFAULT 'running',
    total           INTEGER,
    summary         JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runs_tenant_id_idx ON runs (tenant_id);

CREATE TABLE IF NOT EXISTS results (
    id         VARCHAR(32)  PRIMARY KEY,
    run_id     VARCHAR(32)  NOT NULL REFERENCES runs (id),
    project    VARCHAR(300) NOT NULL DEFAULT '',
    github     VARCHAR(500) NOT NULL DEFAULT '',
    tag        VARCHAR(40)  NOT NULL DEFAULT '',
    backbone   VARCHAR(20)  NOT NULL DEFAULT '',
    score      DOUBLE PRECISION,
    flagged    BOOLEAN      NOT NULL DEFAULT FALSE,
    payload    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS results_run_id_idx ON results (run_id);

-- prepaid KB balances (hackjudge_tokens): one row per tenant, never negative
CREATE TABLE IF NOT EXISTS balances (
    tenant_id     VARCHAR(32)    PRIMARY KEY REFERENCES tenants (id),
    balance_kb    NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance_kb >= 0),
    threshold_kb  NUMERIC(14, 2) NOT NULL DEFAULT 0,
    refill_to_kb  NUMERIC(14, 2) NOT NULL DEFAULT 0,
    auto_recharge BOOLEAN        NOT NULL DEFAULT FALSE,
    updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- metering ledger (hackjudge_tokens settle/credit, hackjudge_store usage_append)
CREATE TABLE IF NOT EXISTS usage_events (
    id           VARCHAR(32)    PRIMARY KEY,
    tenant_id    VARCHAR(32)    NOT NULL REFERENCES tenants (id),
    run_id       VARCHAR(32),
    kind         VARCHAR(40)    NOT NULL DEFAULT '',
    kb_processed NUMERIC(14, 2) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_tenant_id_idx ON usage_events (tenant_id);
