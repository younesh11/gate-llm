// Shared SQL is deliberately compatible with both SQLite and PostgreSQL.
export const notificationSchema = `
CREATE TABLE IF NOT EXISTS notification_settings (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), settings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), issuer_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('member','viewer')), token_hash TEXT NOT NULL UNIQUE, models TEXT NOT NULL, policy_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')), expires_at BIGINT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_invitation ON invitations(workspace_id,email) WHERE status='pending';
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, dedupe TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(user_id,created_at);
CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT, invitation_id TEXT, channel TEXT NOT NULL CHECK(channel IN ('email','sns')), dedupe TEXT NOT NULL UNIQUE, title TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','cancelled')), attempts BIGINT NOT NULL DEFAULT 0, next_at BIGINT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0, claim TEXT, error_code TEXT, provider_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notification_queue ON notification_deliveries(status,next_at);
CREATE TABLE IF NOT EXISTS alert_pending (subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(subject_type,subject_id,day));
`;
