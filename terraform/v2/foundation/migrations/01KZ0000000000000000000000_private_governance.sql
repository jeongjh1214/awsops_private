-- since: 2.1.0-private.1
-- Private/regulatory governance tables ported from the private VM branch.
-- These tables intentionally do not foreign-key to inventory_resources:
-- audit evidence must survive when AWS resources are deleted or age out of sync.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS asset_metadata (
  account_id              TEXT        NOT NULL,
  region                  TEXT        NOT NULL DEFAULT 'global',
  resource_type           TEXT        NOT NULL,
  resource_id             TEXT        NOT NULL,
  owner_team              TEXT        NOT NULL DEFAULT '',
  owner_person            TEXT        NOT NULL DEFAULT '',
  business_system         TEXT        NOT NULL DEFAULT '',
  module_name             TEXT        NOT NULL DEFAULT '',
  phase                   TEXT        NOT NULL DEFAULT 'unknown',
  purpose                 TEXT        NOT NULL DEFAULT '',
  criticality             TEXT        NOT NULL DEFAULT '',
  security_grade          TEXT        NOT NULL DEFAULT '',
  cost_center             TEXT        NOT NULL DEFAULT '',
  contains_personal_info  BOOLEAN,
  remarks                 TEXT        NOT NULL DEFAULT '',
  updated_by              TEXT        NOT NULL DEFAULT '',
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, region, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_metadata_owner
  ON asset_metadata(owner_team, phase);
CREATE INDEX IF NOT EXISTS idx_asset_metadata_resource
  ON asset_metadata(resource_type, account_id);

CREATE TABLE IF NOT EXISTS asset_change_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     TEXT        NOT NULL,
  region         TEXT        NOT NULL DEFAULT 'global',
  resource_type  TEXT        NOT NULL,
  resource_id    TEXT        NOT NULL,
  event_type     TEXT        NOT NULL,
  event_source   TEXT        NOT NULL,
  summary        TEXT        NOT NULL,
  before_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  after_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by     TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_change_events_resource
  ON asset_change_events(account_id, region, resource_type, resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS s3_governance_records (
  account_id                TEXT        NOT NULL,
  bucket_name               TEXT        NOT NULL,
  account_name              TEXT        NOT NULL DEFAULT '',
  phase                     TEXT        NOT NULL DEFAULT '',
  owner_team                TEXT        NOT NULL DEFAULT '',
  purpose                   TEXT        NOT NULL DEFAULT '',
  history                   TEXT        NOT NULL DEFAULT '',
  contains_personal_info    BOOLEAN,
  pii_retention_aware       BOOLEAN,
  pii_retention_applied     BOOLEAN,
  pii_retention_period      TEXT        NOT NULL DEFAULT '',
  remarks                   TEXT        NOT NULL DEFAULT '',
  updated_by                TEXT        NOT NULL DEFAULT '',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, bucket_name)
);
CREATE INDEX IF NOT EXISTS idx_s3_governance_records_phase_owner
  ON s3_governance_records(phase, owner_team);

CREATE TABLE IF NOT EXISTS s3_governance_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     TEXT        NOT NULL,
  bucket_name    TEXT        NOT NULL,
  event_type     TEXT        NOT NULL,
  event_source   TEXT        NOT NULL,
  summary        TEXT        NOT NULL,
  before_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  after_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by     TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_s3_governance_events_record
  ON s3_governance_events(account_id, bucket_name, created_at DESC);

CREATE TABLE IF NOT EXISTS identity_audit_runs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  status              TEXT        NOT NULL CHECK (status IN ('running','completed','failed')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  total_users         INTEGER     NOT NULL DEFAULT 0,
  org_resolved_users  INTEGER     NOT NULL DEFAULT 0,
  changed_users       INTEGER     NOT NULL DEFAULT 0,
  risky_users         INTEGER     NOT NULL DEFAULT 0,
  error_count         INTEGER     NOT NULL DEFAULT 0,
  error_message       TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_identity_audit_runs_started
  ON identity_audit_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS identity_users (
  display_name              TEXT        PRIMARY KEY,
  identity_store_user_id    TEXT        NOT NULL DEFAULT '',
  user_name                 TEXT        NOT NULL DEFAULT '',
  email                     TEXT        NOT NULL DEFAULT '',
  current_org_code          TEXT        NOT NULL DEFAULT '',
  current_org_name          TEXT        NOT NULL DEFAULT '',
  current_assignment_count  INTEGER     NOT NULL DEFAULT 0,
  is_active                 BOOLEAN     NOT NULL DEFAULT true,
  first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_identity_users_org
  ON identity_users(current_org_code, is_active);

CREATE TABLE IF NOT EXISTS identity_org_snapshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID        NOT NULL REFERENCES identity_audit_runs(id) ON DELETE CASCADE,
  display_name  TEXT        NOT NULL,
  org_code      TEXT        NOT NULL DEFAULT '',
  org_name      TEXT        NOT NULL DEFAULT '',
  raw_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  collected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_identity_snapshots_run
  ON identity_org_snapshots(run_id, display_name);

CREATE TABLE IF NOT EXISTS identity_org_change_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID        NOT NULL REFERENCES identity_audit_runs(id) ON DELETE CASCADE,
  display_name  TEXT        NOT NULL,
  old_org_code  TEXT        NOT NULL DEFAULT '',
  old_org_name  TEXT        NOT NULL DEFAULT '',
  new_org_code  TEXT        NOT NULL DEFAULT '',
  new_org_name  TEXT        NOT NULL DEFAULT '',
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_identity_changes_run
  ON identity_org_change_events(run_id, display_name);

CREATE TABLE IF NOT EXISTS identity_aws_assignments (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID        NOT NULL REFERENCES identity_audit_runs(id) ON DELETE CASCADE,
  display_name            TEXT        NOT NULL,
  identity_store_user_id  TEXT        NOT NULL DEFAULT '',
  account_id              TEXT        NOT NULL,
  account_name            TEXT        NOT NULL DEFAULT '',
  permission_set_arn      TEXT        NOT NULL,
  permission_set_name     TEXT        NOT NULL DEFAULT '',
  assignment_type         TEXT        NOT NULL,
  group_id                TEXT        NOT NULL DEFAULT '',
  group_name              TEXT        NOT NULL DEFAULT '',
  collected_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_identity_assignments_run_user
  ON identity_aws_assignments(run_id, display_name);

CREATE TABLE IF NOT EXISTS identity_audit_findings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID        NOT NULL REFERENCES identity_audit_runs(id) ON DELETE CASCADE,
  display_name      TEXT        NOT NULL,
  finding_type      TEXT        NOT NULL,
  severity          TEXT        NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  old_org_code      TEXT        NOT NULL DEFAULT '',
  old_org_name      TEXT        NOT NULL DEFAULT '',
  new_org_code      TEXT        NOT NULL DEFAULT '',
  new_org_name      TEXT        NOT NULL DEFAULT '',
  assignment_count  INTEGER     NOT NULL DEFAULT 0,
  message           TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_identity_findings_run
  ON identity_audit_findings(run_id, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_dataset_registry (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL UNIQUE,
  purpose         TEXT        NOT NULL DEFAULT '',
  owner_team      TEXT        NOT NULL DEFAULT '',
  storage_type    TEXT        NOT NULL DEFAULT 's3' CHECK (storage_type IN ('s3','external','manual')),
  status          TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  created_by      TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_dataset_versions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id       UUID        NOT NULL REFERENCES ai_dataset_registry(id) ON DELETE CASCADE,
  version_label    TEXT        NOT NULL,
  source_uri       TEXT        NOT NULL DEFAULT '',
  manifest_sha256  TEXT        NOT NULL DEFAULT '',
  object_count     INTEGER     NOT NULL DEFAULT 0,
  total_bytes      BIGINT      NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','blocked','retired')),
  approved_by      TEXT        NOT NULL DEFAULT '',
  approved_at      TIMESTAMPTZ,
  created_by       TEXT        NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, version_label)
);
CREATE INDEX IF NOT EXISTS idx_ai_dataset_versions_dataset
  ON ai_dataset_versions(dataset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_dataset_manifest_objects (
  version_id       UUID        NOT NULL REFERENCES ai_dataset_versions(id) ON DELETE CASCADE,
  object_uri       TEXT        NOT NULL,
  object_version   TEXT        NOT NULL DEFAULT '',
  size_bytes       BIGINT      NOT NULL DEFAULT 0,
  etag             TEXT        NOT NULL DEFAULT '',
  checksum_sha256  TEXT        NOT NULL DEFAULT '',
  last_modified    TIMESTAMPTZ,
  PRIMARY KEY (version_id, object_uri, object_version)
);

CREATE TABLE IF NOT EXISTS ai_dataset_integrity_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id      UUID        REFERENCES ai_dataset_registry(id) ON DELETE SET NULL,
  version_id      UUID        REFERENCES ai_dataset_versions(id) ON DELETE SET NULL,
  event_type      TEXT        NOT NULL,
  severity        TEXT        NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  summary         TEXT        NOT NULL,
  evidence_json   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','false_positive')),
  created_by      TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_dataset_integrity_events_scope
  ON ai_dataset_integrity_events(dataset_id, version_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_asset_metadata_touch') THEN
    CREATE TRIGGER trg_asset_metadata_touch BEFORE UPDATE ON asset_metadata
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_s3_governance_records_touch') THEN
    CREATE TRIGGER trg_s3_governance_records_touch BEFORE UPDATE ON s3_governance_records
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_identity_users_touch') THEN
    CREATE TRIGGER trg_identity_users_touch BEFORE UPDATE ON identity_users
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ai_dataset_registry_touch') THEN
    CREATE TRIGGER trg_ai_dataset_registry_touch BEFORE UPDATE ON ai_dataset_registry
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
  END IF;
END $$;
