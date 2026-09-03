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
  /**
   * Milliseconds between transactional-outbox dispatcher passes. `0` disables
   * the dispatcher — strongly discouraged: the post-commit fast path still
   * delivers in the happy case, but nothing retries a delivery that failed on
   * a Redis blip or a crash between COMMIT and flush, which is the gap the
   * outbox exists to close. Every profile runs it (plugin events and job
   * enqueues exist even on a framework boot), unlike the sweeper.
   */
  OUTBOX_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Header carrying the real client IP when the origin sits behind a trusted
   * proxy (Cloudflare zero-trust tunnel: `cf-connecting-ip`). Without it,
   * `request.ip` is the tunnel/pod socket — the SAME address for every player,
   * which collapses every IP-keyed rate-limit bucket into one shared bucket.
   * Setting this is the operator's assertion that the origin is unreachable
   * except through the proxy; on a directly reachable origin the header is
   * client-forgeable and this must stay unset. Never auto-detected for that
   * reason. Blank means unset.
   */
  CLIENT_IP_HEADER: z.string().optional(),
  /** Comma-separated allowlist. Strict CORS per spec §7 — never a wildcard. */
  CORS_ORIGINS: z.string().default("http://localhost:5173").refine(
    (value) => !value.split(",").map((o) => o.trim()).includes("*"),
    { message: "CORS_ORIGINS must not contain a wildcard \"*\" — spec §7 requires a strict allowlist" },
  ),
  /**
   * Which of the four game modes this boot serves. `gl3` is the flagship
   * hybrid — every bundled plugin, curated (see the gl3-hybrid-profile
   * spec). `v2` is the Gangster Legends V2 port (the profile formerly
   * named `full` — that name no longer parses). `mccodes` is the
   * MCCodes-parity game (the attribute family plus crimes/combat/travel).
   * `framework` loads only the game-agnostic set (ranks, notifications,
   * news, bank, mail, forum, inventory, membership), skips jail/hospital,
   * the sentence sweeper, the wealth tax and the gameplay seeds — an
   * openPBBG-shaped engine that gameplay plugins can be added back onto
   * via PLUGIN_IDS (e.g. `GL3_PROFILE=framework PLUGIN_IDS=crimes`).
   */
  GL3_PROFILE: z.enum(["gl3", "v2", "mccodes", "framework"]).default("gl3"),
  /** Comma-separated list of plugin ids to load at boot (spec: Boot sequence step 1). */
  PLUGIN_IDS: z.string().default(""),
  /**
   * Comma-separated npm package specifiers to import at boot from outside this
   * build — see `plugins/dynamic.ts` for why the image forces this.
   *
   * These are LOADED, not merely made available. `PLUGIN_IDS` selects among
   * plugins compiled into the server, where "installed but not enabled" is a
   * real state; a package an operator installed into their plugin directory
   * and then named here has no such state to model, and requiring them to also
   * discover its manifest id — which `available.ts` is emphatic is not its
   * package name — would be a papercut with nothing behind it.
   */
  PLUGIN_PACKAGES: z.string().default(""),
  /**
   * Directory the above are resolved from, e.g. a volume at `/data/plugins`
   * populated by `npm i --prefix /data/plugins @acme/plugin-x`. Unset resolves
   * them from the server's own `node_modules` instead, which is what a
   * from-source deployment wants.
   */
  PLUGIN_DIR: z.string().optional(),

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

  /**
   * Starts the push bus subscriber. Off means the two /api/push/devices
   * routes still work and rows still accumulate — a deployment registers
   * devices before it starts sending, and rolling back is this one variable.
   *
   * An explicit enum rather than `z.coerce.boolean()`: coercion makes every
   * non-empty string truthy, so `PUSH_ENABLED=false` would ENABLE it. A typo
   * fails at boot instead of quietly picking a side.
   */
  PUSH_ENABLED: z.enum(["true", "false", "1", "0"]).default("false"),
  /**
   * Bearer for Expo's send endpoint. Optional: Expo accepts unauthenticated
   * requests for a project's own tokens, and an access token only raises the
   * rate limit. The header is omitted entirely when unset. Blank means unset.
   */
  EXPO_ACCESS_TOKEN: z.string().optional(),
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

export interface PushConfig {
  /** Whether this process runs the bus subscriber; the routes are always on. */
  enabled: boolean;
  expoAccessToken: string | null;
}

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  sessionTtlSeconds: number;
  corsOrigins: string[];
  nodeEnv: "development" | "test" | "production";
  /** Trusted client-IP header (e.g. `cf-connecting-ip`), or null to use the socket address. */
  clientIpHeader: string | null;
  /** The game mode: `gl3` (hybrid union), `v2` (the GL2 port), `mccodes`
   *  (the MCCodes-parity set), `framework` (game-agnostic subset). */
  profile: "gl3" | "v2" | "mccodes" | "framework";
  pluginIds: string[];
  /** Package specifiers imported at boot from outside this build. */
  pluginPackages: string[];
  /** Where those are resolved from; `null` means the server's own node_modules. */
  pluginDir: string | null;
  sweepIntervalMs: number;
  outboxIntervalMs: number;
  assets: AssetConfig;
  mail: MailConfig;
  push: PushConfig;
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
    clientIpHeader: parsed.CLIENT_IP_HEADER?.trim() ? parsed.CLIENT_IP_HEADER.trim() : null,
    profile: parsed.GL3_PROFILE,
    pluginIds: parsed.PLUGIN_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    pluginPackages: parsed.PLUGIN_PACKAGES.split(",").map((p) => p.trim()).filter(Boolean),
    pluginDir: parsed.PLUGIN_DIR ?? null,
    sweepIntervalMs: parsed.SWEEP_INTERVAL_MS,
    outboxIntervalMs: parsed.OUTBOX_INTERVAL_MS,
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
    push: {
      enabled: parsed.PUSH_ENABLED === "true" || parsed.PUSH_ENABLED === "1",
      expoAccessToken: parsed.EXPO_ACCESS_TOKEN?.trim() ? parsed.EXPO_ACCESS_TOKEN.trim() : null,
    },
  };
}
