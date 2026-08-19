import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_TTL: z.coerce.number().int().positive().default(604800),
  /**
   * Milliseconds between sentence-sweeper passes. `0` disables the sweeper,
   * which is safe: `releaseIfExpired`/`settleHospital` still free players
   * lazily on their next request, exactly as they did before the sweeper
   * existed. Non-negative rather than positive for that reason.
   */
  SWEEP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Comma-separated allowlist. Strict CORS per spec §7 — never a wildcard. */
  CORS_ORIGINS: z.string().default("http://localhost:5173").refine(
    (value) => !value.split(",").map((o) => o.trim()).includes("*"),
    { message: "CORS_ORIGINS must not contain a wildcard \"*\" — spec §7 requires a strict allowlist" },
  ),
  /** Comma-separated list of plugin ids to load at boot (spec: Boot sequence step 1). */
  PLUGIN_IDS: z.string().default(""),

  /**
   * Which object-storage backend serves game art. `fs` writes under
   * `ASSET_FS_ROOT` and serves through this server's own `/assets/:key` route;
   * `s3` writes to any S3-compatible bucket (Cloudflare R2, AWS) and serves
   * from `ASSET_CDN_BASE`. Both are real backends — see `assets/driver.ts`.
   */
  ASSET_DRIVER: z.enum(["fs", "s3"]).default("fs"),
  ASSET_FS_ROOT: z.string().default("var/assets"),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** R2 wants the literal `auto`; AWS wants a real region. */
  S3_REGION: z.string().default("auto"),
  /** Public base the browser fetches images from, e.g. `https://cdn.example.com`. */
  ASSET_CDN_BASE: z.string().optional(),

  /** Outbound mail. `log` prints to stdout (dev/test); `resend` POSTs to api.resend.com. */
  EMAIL_DRIVER: z.enum(["log", "resend"]).default("log"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().default("noreply@gl3.dev"),
  /** Web origin used to build links in outbound mail (verify, reset). */
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),
}).superRefine((env, ctx) => {
  // Selecting `s3` with a field missing must fail HERE, at boot, rather than on
  // the first upload an admin attempts — which would be days later, in
  // production, with a 500 and no clue which of six variables was forgotten.
  if (env.ASSET_DRIVER === "s3") {
    for (const key of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "ASSET_CDN_BASE"] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when ASSET_DRIVER=s3`,
        });
      }
    }
  }

  if (env.EMAIL_DRIVER === "resend" && !env.RESEND_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["RESEND_API_KEY"],
      message: "RESEND_API_KEY is required when EMAIL_DRIVER=resend" });
  }
});

export interface AssetConfig {
  driver: "fs" | "s3";
  fsRoot: string;
  s3: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string; cdnBase: string } | null;
}

export interface MailConfig {
  driver: "log" | "resend";
  apiKey: string | null;
  from: string;
  appBaseUrl: string;
}

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  sessionTtlSeconds: number;
  corsOrigins: string[];
  nodeEnv: "development" | "test" | "production";
  pluginIds: string[];
  sweepIntervalMs: number;
  assets: AssetConfig;
  mail: MailConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    sessionTtlSeconds: parsed.SESSION_TTL,
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    nodeEnv: parsed.NODE_ENV,
    pluginIds: parsed.PLUGIN_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    sweepIntervalMs: parsed.SWEEP_INTERVAL_MS,
    assets: {
      driver: parsed.ASSET_DRIVER,
      fsRoot: parsed.ASSET_FS_ROOT,
      // Non-null exactly when the driver is `s3`: the superRefine above has
      // already proven every field is present, so this narrows without `!`
      // on each one and without a second round of validation.
      s3: parsed.ASSET_DRIVER === "s3" && parsed.S3_ENDPOINT && parsed.S3_BUCKET
        && parsed.S3_ACCESS_KEY_ID && parsed.S3_SECRET_ACCESS_KEY && parsed.ASSET_CDN_BASE
        ? {
          endpoint: parsed.S3_ENDPOINT,
          bucket: parsed.S3_BUCKET,
          accessKeyId: parsed.S3_ACCESS_KEY_ID,
          secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
          region: parsed.S3_REGION,
          cdnBase: parsed.ASSET_CDN_BASE.replace(/\/+$/, ""),
        }
        : null,
    },
    mail: {
      driver: parsed.EMAIL_DRIVER,
      apiKey: parsed.RESEND_API_KEY ?? null,
      from: parsed.EMAIL_FROM,
      appBaseUrl: parsed.APP_BASE_URL.replace(/\/+$/, ""),
    },
  };
}
