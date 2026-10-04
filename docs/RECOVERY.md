# Backup, restore and account recovery

GATE 0.2.2 adds offline maintenance commands for a single instance. Use the same release that wrote the data (schema 3 for this release). Commands print a JSON result on success and exit nonzero on failure. They work through the npm CLI, Python launcher and Docker entrypoint. Stop the gateway and disable automatic restarts before backup or password reset; an active owner causes the command to refuse access.

## Create and verify a backup

For npm or pip installations, after stopping the server:

```sh
mkdir -p "$HOME/gate-backups"
gate-llm backup --data-dir "$HOME/.gate-llm" --output "$HOME/gate-backups/before-upgrade"
gate-llm verify-backup --input "$HOME/gate-backups/before-upgrade"
```

The output directory must not exist, and its parent must already exist. Choose a path outside the source data directory. No source state is initialized or migrated, and unfinished reservations remain intact. A SQLite `VACUUM INTO` snapshot includes committed WAL transactions in one standalone database. The directory contains exactly `relay.sqlite`, `encryption.key` and `backup-manifest.json`. The manifest records the format, GATE/schema versions, creation time and SHA-256 checksums. Verification checks checksums, SQLite integrity, foreign keys, expected tables and decryption of stored provider credentials.

Directories use mode 0700 and files mode 0600 on POSIX systems. **This is not an encrypted backup archive:** the backup contains the provider decryption key, password hashes, virtual-key hashes, account metadata and usage records. Use encrypted private storage, restrict access, and keep a separate off-host copy. On Windows, configure filesystem ACLs. Checksums detect corruption; they do not authenticate the source. Restore only backups from storage you trust. Verification cannot check a key against provider ciphertext when no provider credentials are stored.

The manifest is written last. A failed/interrupted command may leave an incomplete destination; use a new name when retrying. Verification rejects incomplete snapshots, extra files and linked files. Do not start the gateway in a backup directory or manually add WAL/lock files to it.

## Restore into a new directory

```sh
gate-llm verify-backup --input "$HOME/gate-backups/before-upgrade"
gate-llm restore --input "$HOME/gate-backups/before-upgrade" --data-dir "$HOME/.gate-llm-restored"
gate-llm serve --data-dir "$HOME/.gate-llm-restored" --port 4313
```

Restore requires an explicit, nonexistent destination with an existing parent. Even an empty existing directory is refused. The original directory and backup are retained. All saved dashboard sessions are invalidated, and a `backup.restore` audit event is recorded. Provider credentials, users, passwords, virtual keys, model permissions, policies, prices, budgets, token allowances, usage, rate windows and pending reservations are preserved. On startup, pending reservations are settled conservatively once, just as after a crash.

If restore fails after it starts copying, `restore.incomplete` keeps GATE from opening partial state. Leave that directory unused and restore again into a new destination. Do not remove this marker to force startup. No in-place overwrite or automatic rollback is provided.

Before switching clients, check `/ready`, sign in, inspect models/policies/keys and verify usage against your records. Switch your service's `--data-dir` or `DATA_DIR` to the restored directory, then start the service. A restore returns configuration and usage to the snapshot time: later consumption is absent, and keys revoked or rotated after the backup can regain their old state. Reconcile usage and review/revoke/rotate affected keys before exposing the restored gateway. An isolated drill should not receive production traffic or make billable model calls.

## Recover a dashboard password

Stop the gateway, then run:

```sh
gate-llm reset-password --data-dir "$HOME/.gate-llm" --email owner@example.com
```

The terminal asks for and confirms a 12–200 character password without displaying it. No default password is created. The account must already exist; its role and API keys remain unchanged. The password update, deletion of that account's sessions, and `account.password_reset` audit entry commit together. Other accounts' sessions remain valid. Start the gateway again and sign in with the new password.

Automation can pipe exactly one UTF-8 password line using `--password-stdin`; an optional final newline is removed, and other whitespace is preserved. Obtain the password from your secret manager. Do not put it in a command argument, shell history or an environment file. Without that flag, noninteractive input is rejected. This is local administrator recovery requiring filesystem access, not an emailed reset link or a dashboard endpoint.

## Docker example

The default Compose project uses the `gate-llm_relay-data` volume. Substitute your actual volume name if the project name changed. These commands use the published image and create separate named volumes for backup and restored state:

```sh
docker compose stop relay
docker volume create gate-backups
docker run --rm --init \
  --volume gate-llm_relay-data:/source \
  --volume gate-backups:/app/data \
  ghcr.io/younesh11/gate-llm:0.2.2 \
  backup --data-dir /source --output /app/data/before-upgrade
docker run --rm --init --volume gate-backups:/app/data:ro \
  ghcr.io/younesh11/gate-llm:0.2.2 \
  verify-backup --input /app/data/before-upgrade
docker compose start relay

# Restore drill: a new volume, separate from the running service.
docker volume create gate-restored
docker run --rm --init \
  --volume gate-backups:/backups:ro \
  --volume gate-restored:/app/data \
  ghcr.io/younesh11/gate-llm:0.2.2 \
  restore --input /backups/before-upgrade --data-dir /app/data/restored
docker run --rm --init --publish 127.0.0.1:4313:4310 \
  --volume gate-restored:/app/data \
  ghcr.io/younesh11/gate-llm:0.2.2 serve --data-dir /app/data/restored
```

For a password reset on the original Compose state:

```sh
docker compose stop relay
docker compose run --rm --no-deps relay reset-password --email owner@example.com
docker compose start relay
```

The interactive command needs a terminal; automation should use `docker compose run --rm --no-deps -T relay reset-password --email owner@example.com --password-stdin` with a secret-manager pipe. Do not remove state volumes during upgrades. Named backup volumes on the same host are not protection against host loss; copy backups to private off-host storage separately.

## Drills and remaining limits

The test suite exercises integrity failures, wrong keys, live-owner refusal, preservation of usage and credentials, crashed WAL recovery, session invalidation and atomic password reset. Packaged npm/Python smoke tests and a disposable Docker volume drill exercise the shipped commands. For an actual deployment, schedule backups and isolated restore drills externally, monitor failures, and choose retention based on how much data loss is acceptable. Built-in scheduling, cloud uploads, archive encryption and point-in-time recovery are not included.
