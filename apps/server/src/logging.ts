import type { FastifyRequest } from "fastify";
import { clientIp } from "./auth/rate-limit.js";

/**
 * Replacement for Fastify's default `req` log serializer, which records
 * `request.ip` — the raw socket peer. Behind a Cloudflare tunnel that is the
 * tunnel/pod address for every player, so the request log showed Cloudflare
 * while rate limits, presence and `signup_ip`/`last_ip` (all through
 * `clientIp`, honoring `CLIENT_IP_HEADER`) showed the real client.
 *
 * `ip` is `clientIp`'s answer — the same trust model, so an unset header is
 * never read (client-forgeable on a directly reachable origin). The socket
 * peer stays beside it as `remoteAddress`, the one datum that debugs the
 * proxy path itself. Fastify passes the FastifyRequest to this serializer,
 * which is what makes `.headers` and `.ip` available; asserted by
 * `test/request-log-serializer.test.ts` through a real instance.
 */
export interface RequestLogFields {
  method: string;
  url: string;
  host: string;
  /** `clientIp()`'s answer — the header when configured and present, else the socket. */
  ip: string;
  /** Always the socket peer, even when `ip` came from the header. */
  remoteAddress: string;
  remotePort?: number;
  /** Fastify's serializer return type carries an index signature; mirrored so this assigns to it. */
  [key: string]: unknown;
}

export function requestLogSerializer(clientIpHeader: string | null | undefined) {
  return function serializeRequest(req: FastifyRequest): RequestLogFields {
    const remotePort = req.socket?.remotePort;
    return {
      method: req.method,
      url: req.url,
      host: req.host,
      ip: clientIp(req, clientIpHeader),
      remoteAddress: req.ip,
      ...(remotePort === undefined ? {} : { remotePort }),
    };
  };
}
