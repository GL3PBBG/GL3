import { z } from "zod";
import type { PluginCtx } from "./ctx.js";

export interface RouteResult {
  status: number;
  body?: unknown;
}

/** Optional transport data supplied by the HTTP loader, not direct/test calls. */
export interface RouteTransport {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Original bytes, only for routes that opt into rawBody. Never reserialized JSON. */
  readonly rawBody?: Uint8Array;
}

export interface RouteDef<P extends z.ZodTypeAny, B extends z.ZodTypeAny, Q extends z.ZodTypeAny> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth?: "player" | "public" | "admin";
  /** V2 module.json parity. Default true — only actions gate on jail. */
  accessInJail?: boolean;
  /**
   * Whether the route answers while the player is in hospital. Defaults to
   * `true`, so every route that predates the hospital facility is unaffected.
   * An action a wounded player should not be able to take sets `false` and
   * the loader answers 423 + `retry-after`.
   */
  accessInHospital?: boolean;
  /** Deliver the body as untouched bytes for webhook signature verification. */
  rawBody?: boolean;
  params?: P;
  body?: B;
  /**
   * Query-string schema, parsed from the raw `?key=value` pairs (`page` etc.)
   * — Fastify never merges these into `request.params`, so before this field
   * existed a plugin route had no way to read one at all. Optional and
   * defaulted to `z.unknown()`, same as `params`/`body`, so every route
   * predating this field is unaffected.
   */
  query?: Q;
  handler: (
    ctx: PluginCtx,
    input: { params: z.infer<P>; body: z.infer<B>; query: z.infer<Q> } & RouteTransport,
  ) => Promise<RouteResult>;
}

/**
 * The type-erased form the loader stores. `handler` is declared with METHOD
 * SHORTHAND on purpose: method parameters are bivariant, so a handler typed
 * against the plugin's own `z.infer<P>` assigns here without a cast. Written
 * as a property (`handler: (…) => …`) `strictFunctionTypes` would reject it
 * contravariantly and force an `any` — which `packages/*` does not permit.
 */
export interface PluginRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth: "player" | "public" | "admin";
  accessInJail: boolean;
  accessInHospital: boolean;
  rawBody?: boolean;
  params: z.ZodTypeAny;
  body: z.ZodTypeAny;
  query: z.ZodTypeAny;
  handler(ctx: PluginCtx, input: { params: unknown; body: unknown; query: unknown } & RouteTransport): Promise<RouteResult>;
}

export function route<
  P extends z.ZodTypeAny = z.ZodUnknown,
  B extends z.ZodTypeAny = z.ZodUnknown,
  Q extends z.ZodTypeAny = z.ZodUnknown,
>(def: RouteDef<P, B, Q>): PluginRoute {
  return {
    method: def.method,
    path: def.path,
    auth: def.auth ?? "player",
    accessInJail: def.accessInJail ?? true,
    accessInHospital: def.accessInHospital ?? true,
    ...(def.rawBody === undefined ? {} : { rawBody: def.rawBody }),
    params: def.params ?? z.unknown(),
    body: def.body ?? z.unknown(),
    query: def.query ?? z.unknown(),
    handler: def.handler,
  };
}
