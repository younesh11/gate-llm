import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const markerPrefix = 'GATE_SQLITE_LOCK_V1 ';
const occupied = 'This data directory is already in use. Run one gateway instance per directory.';

// A separate SQLite transaction owns the directory without blocking normal data writes.
// The OS releases it even after SIGKILL, independent of PIDs or container namespaces.
// Never unlink the lock database: doing so would allow locks on two different inodes.
export class DirectoryLock {
  private connection: DatabaseSync;
  private markerPath: string;
  private marker = `${markerPrefix}${process.pid} ${randomUUID()}\n`;
  private closed = false;
  private ownsMarker = false;

  constructor(directory: string) {
    const path = join(directory, 'process-lock.sqlite');
    this.markerPath = join(directory, 'process.lock');
    this.connection = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.connection.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
      if (existsSync(this.markerPath)) {
        const previous = readFileSync(this.markerPath, 'utf8');
        if (!previous.startsWith(markerPrefix)) {
          // Respect pre-0.2.1 owners during an upgrade. An ambiguous legacy lock
          // requires an operator to verify the old process has stopped.
          const pid = Number(previous.trim());
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid legacy process.lock. Verify the old gateway is stopped before removing this marker.');
          let alive = true;
          try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
          if (alive) throw new Error(`${occupied} A legacy process.lock is present; verify the old gateway is stopped before removing the marker.`);
        }
        unlinkSync(this.markerPath);
      }
      // The nonnumeric marker also makes older GATE versions refuse concurrent startup.
      writeFileSync(this.markerPath, this.marker, { flag: 'wx', mode: 0o600 });
      this.ownsMarker = true;
    } catch (error: any) {
      this.connection.close();
      if ([5, 6].includes(error.errcode)) throw new Error(occupied);
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    try {
      if (this.ownsMarker && existsSync(this.markerPath) && readFileSync(this.markerPath, 'utf8') === this.marker) unlinkSync(this.markerPath);
    } finally {
      this.connection.close();
      this.closed = true;
    }
  }
}
