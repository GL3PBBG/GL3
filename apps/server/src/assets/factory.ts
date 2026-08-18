import { isAbsolute, resolve } from "node:path";
import type { AssetConfig } from "../config.js";
import type { StorageDriver } from "./driver.js";
import { FilesystemDriver } from "./fs-driver.js";
import { S3Driver } from "./s3-driver.js";

/**
 * Pick the backend from config. `config.ts` has already proven an `s3`
 * selection carries every field it needs, so there is nothing to re-validate
 * here and no partially-configured state to guard against.
 */
export function createStorageDriver(config: AssetConfig): StorageDriver {
  if (config.driver === "s3") {
    if (config.s3 === null) {
      // Unreachable: loadConfig's superRefine rejects this combination at boot.
      // Kept because the alternative is a non-null assertion on a field whose
      // invariant lives in another file.
      throw new Error("ASSET_DRIVER=s3 but no S3 configuration was parsed");
    }
    return new S3Driver(config.s3);
  }
  // Relative roots resolve against the process cwd, which is the repo root for
  // `npm run dev` and the app dir in the container. Absolute wins untouched so
  // a deployment can mount a volume anywhere.
  const root = isAbsolute(config.fsRoot) ? config.fsRoot : resolve(process.cwd(), config.fsRoot);
  return new FilesystemDriver(root);
}
