# Upgrades and backups

1. Read CHANGELOG.md and the release notes for migrations or changed limits.
2. Stop the gateway and wait for accepted requests to finish.
3. Back up the **whole** data directory, including relay.sqlite, any WAL files and encryption.key. Keep backups private. Do not commit or publish them.
4. Install the new pinned package/image and start it with the same data path or named volume.
5. Check /health, sign in, and verify models, keys and usage before reconnecting clients.

Never run two versions against one data directory. The process lock guards concurrent writers, but is not a backup mechanism. Do not manually delete a live process lock.

For Compose, use `docker compose stop`, preserve the named volume, and rebuild/pull the desired version. `docker compose down -v` destroys state. Restore a backup of both the database and encryption key when rolling back a schema migration; installing an older binary alone is insufficient.

For pip/npm, data is outside the installation directory. Upgrading a package does not move it. The Python cache is versioned and can be removed when no running process uses it; it contains program code, not user data.

Earlier Relay development installations used explicit `./data`, `./data/demo` or `./data/private-test`. Continue using those paths through `--data-dir`/DATA_DIR. The new CLI default is `~/.gate-llm`; an empty dashboard usually means a different data path was selected.

The initial packaged release retains schema version 2. Its earlier development migration changed a numeric max-output limit into the same numeric combined input/output request limit. Review small legacy limits when requests no longer fit.

Version 0.2.0 guardrail changes migrate to schema version 3. Existing policies retain their flags, terms and key assignments, with email/US SSN categories and substring matching. Phone/card categories remain opt-in. Credential detection and normalization are stronger, so some inputs previously accepted may now be blocked. Test representative inputs in the policy editor before using the new checks with applications. Restore a full pre-upgrade backup to roll back to 0.1.0.
