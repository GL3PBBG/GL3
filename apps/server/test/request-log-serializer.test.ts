import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { requestLogSerializer } from "../src/logging.js";

/**
 * Fastify's default `req` serializer logs `request.ip`, the raw socket peer.
 * Behind a Cloudflare tunnel that is the tunnel/pod address for every player,
 * while `clientIp()` (rate limits, presence, signup_ip/last_ip) already reads
 * `CLIENT_IP_HEADER`. This serializer puts the same answer in the request
 * log — one trust model, one source of truth — and keeps the socket address
 * beside it as `remoteAddress` for debugging the proxy path itself.
 *
 * Driven through a REAL Fastify instance with a capturing log stream, not by
 * calling the serializer directly: the fact under test is that Fastify hands
 * the serializer a FastifyRequest (so `.headers` and `.ip` exist), which a
 * direct call would merely assume.
 */
interface ReqLogLine {
  req?: { ip?: string; remoteAddress?: string; method?: string; url?: string };
}

async function captureRequestLog(
  clientIpHeader: string | null,
  inject: { headers?: Record<string, string>; remoteAddress: string },
): Promise<ReqLogLine["req"]> {
  const lines: ReqLogLine[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line) as ReqLogLine);
      }
      cb();
    },
  });
  const app = Fastify({ logger: { level: "info", stream, serializers: { req: requestLogSerializer(clientIpHeader) } } });
  app.get("/", async () => ({ ok: true }));
  await app.inject({ method: "GET", url: "/", ...inject });
  await app.close();
  const withReq = lines.find((l) => l.req !== undefined);
  if (withReq === undefined) throw new Error("no request log line captured");
  return withReq.req;
}

describe("request log serializer", () => {
  it("logs the configured header's IP, keeping the socket as remoteAddress", async () => {
    const req = await captureRequestLog("cf-connecting-ip", {
      headers: { "cf-connecting-ip": "203.0.113.9" }, remoteAddress: "10.0.0.5",
    });
    expect(req?.ip).toBe("203.0.113.9");
    expect(req?.remoteAddress).toBe("10.0.0.5");
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe("/");
  });

  it("falls back to the socket when the configured header is absent", async () => {
    const req = await captureRequestLog("cf-connecting-ip", { remoteAddress: "10.0.0.5" });
    expect(req?.ip).toBe("10.0.0.5");
  });

  it("ignores the header entirely when none is configured (client-forgeable)", async () => {
    const req = await captureRequestLog(null, {
      headers: { "cf-connecting-ip": "203.0.113.9" }, remoteAddress: "10.0.0.5",
    });
    expect(req?.ip).toBe("10.0.0.5");
  });
});
