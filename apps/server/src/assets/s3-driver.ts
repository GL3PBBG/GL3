import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageDriver } from "./driver.js";

export interface S3DriverConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  cdnBase: string;
}

/**
 * S3-compatible object storage: Cloudflare R2 in production, AWS S3 or MinIO
 * anywhere else. One driver covers all three because they speak the same API —
 * R2 only wants `region: "auto"` and `forcePathStyle`.
 *
 * This path is NOT exercised by `npm run verify`, which is a deliberate,
 * recorded trade: the suite must run offline and must not depend on a
 * credentialled bucket shared between concurrent agents. What covers it instead
 * is `test/asset-driver-contract.test.ts`, whose cases run against the
 * filesystem driver always and against a real endpoint when `S3_TEST_ENDPOINT`
 * is exported. Run that before trusting a deployment.
 */
export class S3Driver implements StorageDriver {
  private readonly client: S3Client;

  constructor(private readonly config: S3DriverConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // R2 and MinIO both reject virtual-host-style addressing for arbitrary
      // bucket names; path style works on all three backends.
      forcePathStyle: true,
    });
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: bytes,
      ContentType: mime,
      // The key is the content hash, so the object is immutable by
      // construction and a CDN may keep it forever.
      CacheControl: "public, max-age=31536000, immutable",
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (result.Body === undefined) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      // A miss is a null per the interface. Everything else — credentials,
      // network, a bucket that does not exist — must propagate, because
      // swallowing it would read as "no art uploaded" and hide a broken
      // deployment behind a placeholder image.
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  urlFor(key: string): string {
    return `${this.config.cdnBase}/${key}`;
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "NoSuchKey" || name === "NotFound") return true;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return status === 404;
}
