import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StorageDriver } from "./driver.js";

/**
 * Filesystem-backed object storage: development, and every integration test.
 *
 * Objects are sharded by the first two characters of the key
 * (`ab/abcdef...`). A flat directory is fine at a hundred objects and
 * unpleasant at a hundred thousand — ext4 copes, but `ls` and any backup tool
 * stop being usable, and the sharding costs one `substring` to buy that back.
 *
 * The key is always a sha256 from `hashBytes`, never user input: the upload
 * route derives it from the bytes, and the serve route validates the param
 * against `/^[0-9a-f]{64}$/` before a driver ever sees it. `assertKey` below
 * re-checks anyway, because "the caller validated it" is exactly the assumption
 * that turns into a path traversal two refactors later.
 */
export class FilesystemDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    assertKey(key);
    return join(this.root, key.slice(0, 2), key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename rather than a plain write. Two uploads of the same
    // bytes race here routinely (content-addressed keys make collisions the
    // normal case, not the exceptional one), and a reader must never observe a
    // half-written object under a key whose whole contract is that its content
    // is the hash. `rename` within one filesystem is atomic; the temp name
    // carries the pid so two processes cannot pick the same one.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      // A miss is a null, not a throw — the interface says so, and the serve
      // route turns it into a 404. Anything that is not "no such file" is a
      // real failure (permissions, EIO) and must not be swallowed into a 404,
      // which would read as "no art uploaded" and hide a broken disk.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  urlFor(key: string): string {
    assertKey(key);
    return `/assets/${key}`;
  }
}

const KEY_RE = /^[0-9a-f]{64}$/;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`invalid asset key: ${JSON.stringify(key)}`);
}
