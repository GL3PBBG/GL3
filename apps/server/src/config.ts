import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_TTL: z.coerce.number().int().positive().default(604800),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Comma-separated allowlist. Strict CORS per spec §7 — never a wildcard. */
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
});

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  sessionTtlSeconds: number;
  corsOrigins: string[];
  nodeEnv: "development" | "test" | "production";
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
  };
}
