// -----------------------------------------------------------------------------
// What /data keeps across restarts, in three files (mode 0600): the state
// (next refresh, pauses), the tariffs read (grid companies, Energinet) and the
// spot prices read (62 days). No secret: the integration has none. Written through a temporary file and a rename, one
// save after the other. A missing file is empty; a file that cannot be read
// (EACCES, EIO, too large) is NOT empty: never overwritten; one that does not
// parse is moved aside to `.bad` first.
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;

export class StoreUnreadable extends Error {
  constructor(reason) {
    super(`/data unreadable (${reason})`);
    this.name = 'StoreUnreadable';
  }
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name } = {}) {
    this.path = join(dir, name);
    this.queue = Promise.resolve();
  }

  /** The saved object; {} when the file does not exist; throws when it cannot be read. */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw new StoreUnreadable(err?.code ?? 'error');
    }
    if (text.length > MAX_BYTES) throw new StoreUnreadable('too large');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // A torn or foreign file: set aside as `.bad` (kept for a look), never
      // overwritten in place; when it cannot be moved, it is unreadable.
      await this.setAside();
      return {};
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    // Valid JSON but not ours (an array, a number): set aside like a torn file.
    await this.setAside();
    return {};
  }

  /** Moves the file to `.bad`; when it cannot be moved, it is unreadable. */
  async setAside() {
    try {
      await rename(this.path, `${this.path}.bad`);
    } catch (err) {
      throw new StoreUnreadable(err?.code ?? 'unparsable');
    }
  }

  /** Saves after the previous save (the last one always lands last). */
  save(data) {
    const write = async () => {
      const tmp = `${this.path}.tmp`;
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.path);
    };
    const job = this.queue.then(write, write);
    this.queue = job.catch(() => {});
    return job;
  }

  flush() {
    return this.queue;
  }
}

/** The same in memory (tests): `fail`, `hang` and `unreadable` simulate a bad volume. */
export function createMemoryStore(initial = {}) {
  const store = {
    data: structuredClone(initial),
    saves: 0,
    loads: 0,
    unreadable: false,
    hang: false,
    failSave: false,
    async load() {
      store.loads += 1;
      if (store.hang) return new Promise(() => {});
      if (store.unreadable) throw new StoreUnreadable('EIO');
      return structuredClone(store.data);
    },
    async save(next) {
      if (store.failSave) throw new Error('EROFS');
      store.saves += 1;
      store.data = structuredClone(next);
    },
    flush: async () => {},
  };
  return store;
}
