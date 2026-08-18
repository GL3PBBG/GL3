/**
 * Object storage, behind the smallest interface that covers what the asset
 * pipeline actually does. Two real implementations exist — filesystem
 * (development and the test suite) and S3-compatible (production, Cloudflare R2
 * or AWS). Neither is a mock: the filesystem driver is a real backend that
 * really stores bytes, which is why the contract suite in
 * `test/asset-driver-contract.test.ts` can be run unchanged against either.
 *
 * `key` is always the sha256 of the content — the blob is content-addressed.
 * That is what makes `put` idempotent, `urlFor` cacheable forever, and an
 * overwrite of an existing key a no-op by definition rather than by policy.
 */
export interface StorageDriver {
  /** Store bytes under `key`. Storing the same key twice must not fail. */
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  /** Read bytes back, or null when the key was never stored. Never throws on a miss. */
  get(key: string): Promise<Buffer | null>;
  /** Remove the object. Deleting a key that is not there must not fail. */
  delete(key: string): Promise<void>;
  /**
   * Where a browser fetches this object from. The ONE place the two drivers
   * visibly diverge: the filesystem driver returns a root-relative path served
   * by this server, the S3 driver returns an absolute CDN URL. Nothing above
   * the driver knows or cares which.
   */
  urlFor(key: string): string;
}
