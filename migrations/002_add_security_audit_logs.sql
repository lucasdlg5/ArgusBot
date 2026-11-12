-- =============================================================================
-- ARGUS (moneta-argus) - Migration 002: Security Audit & Threat Detection
-- =============================================================================

CREATE TABLE IF NOT EXISTS argus.security_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id BIGINT NOT NULL,
  telegram_username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code VARCHAR(16),
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  chat_id BIGINT,
  chat_type VARCHAR(32),
  interaction_type VARCHAR(32) NOT NULL CHECK (
    interaction_type IN ('COMMAND', 'TEXT', 'PHOTO', 'DOCUMENT', 'CALLBACK_QUERY', 'OTHER')
  ),
  command_or_action TEXT,
  payload_preview TEXT,
  threat_level VARCHAR(16) NOT NULL CHECK (
    threat_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
  ),
  threat_category VARCHAR(64) NOT NULL,
  attempt_count_in_window INTEGER NOT NULL DEFAULT 1,
  blocked BOOLEAN NOT NULL DEFAULT TRUE,
  raw_update_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_argus_security_logs_user_date
  ON argus.security_audit_logs(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_argus_security_logs_threat
  ON argus.security_audit_logs(threat_level, created_at DESC);

CREATE OR REPLACE VIEW argus.v_security_threat_summary AS
SELECT
  telegram_user_id,
  COALESCE(MAX(telegram_username), 'sem_username') AS telegram_username,
  MAX(first_name) AS first_name,
  MAX(last_name) AS last_name,
  COUNT(*) AS total_blocked_attempts,
  MIN(created_at) AS first_seen_at,
  MAX(created_at) AS last_seen_at,
  ARRAY_AGG(DISTINCT interaction_type) AS interaction_types,
  ARRAY_AGG(DISTINCT threat_category) AS threat_categories,
  CASE
    WHEN BOOL_OR(threat_level = 'CRITICAL') THEN 'CRITICAL'
    WHEN BOOL_OR(threat_level = 'HIGH') THEN 'HIGH'
    WHEN BOOL_OR(threat_level = 'MEDIUM') THEN 'MEDIUM'
    ELSE 'LOW'
  END AS max_threat_level
FROM argus.security_audit_logs
GROUP BY telegram_user_id;
