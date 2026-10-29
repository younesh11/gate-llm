// Append migrations: published notification migrations must retain their checksums.
export const postgresAdminRoleSchema = `
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK(role IN ('admin','member','viewer'));
`;
export const sqliteAdminRoleSchema = `
CREATE TABLE invitations_v8 (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), issuer_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')), token_hash TEXT NOT NULL UNIQUE, models TEXT NOT NULL, policy_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')), expires_at BIGINT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO invitations_v8 SELECT * FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_v8 RENAME TO invitations;
CREATE UNIQUE INDEX one_pending_invitation ON invitations(workspace_id,email) WHERE status='pending';
PRAGMA user_version=8;
`;
