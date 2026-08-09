// Static file server for the built Vite bundle, used only by Dockerfile.web.
//
// This is the one file in the repo outside TypeScript's coverage, and that is
// deliberate: apps/web is `noEmit` (tsc typechecks it, Vite builds it), so a
// .ts file here would need a build step of its own to produce one deployment
// script. Plain ESM runs as-is on the node:22-alpine runtime stage.
//
// Zero dependencies on purpose — @fastify/static is not in package-lock.json,
// and adding a dependency tree to serve one directory would cost more than it
// buys. The tradeoff is that the path-traversal guard below is ours to get
// right rather than a library's; it is the security-load-bearing part of this
// file, so read it before changing it.
//
// Ingress (Rancher) terminates TLS and routes /api and /ws to the server
// image, so this process only ever serves the SPA's own assets.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("./dist", import.meta.url)));
const PORT = Number(process.env.PORT ?? 8080);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".map", "application/json; charset=utf-8"],
]);

/**
 * Resolves a URL path to a file inside ROOT, or null if it escapes.
 *
 * The decode happens first so that percent-encoded traversal (%2e%2e%2f) is
 * normalised before resolve() runs — checking the raw pathname would miss it.
 * The containment test uses ROOT + sep, not a bare startsWith(ROOT): without
 * the separator, a sibling directory whose name merely begins with ROOT's
 * (e.g. /app/dist-backup next to /app/dist) would pass.
 */
function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  // "\u0000", not a literal NUL byte typed into the source. The two are the
  // same string to JavaScript, but a raw NUL makes git classify this whole file
  // as binary, so every diff of it reads `Bin 4750 -> 6967 bytes` and no change
  // to this server -- including a change to the guard on this line -- can be
  // reviewed. Keep it escaped.
  if (decoded.includes("\u0000")) return null;

  const candidate = resolve(join(ROOT, decoded));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

/**
 * True when a path that matched no file should fall back to index.html (it is a
 * client-side route), false when it should 404 (it is a missing asset).
 *
 * The policy is unchanged and still the point: a missing *asset* must 404
 * honestly, because serving index.html in its place answers a script request
 * with HTML and turns a broken build into a blank page with a MIME error
 * instead of a legible missing-file error.
 *
 * What changed is the classifier. "Carries an extension" is not the same
 * question as "is an asset", and the gap between them is a real production
 * 404: `extname("/plugins/hello.index")` returns ".index", so every plugin page
 * — ids are dotted by convention, and v1 routing serves all of them from
 * /plugins/:pageId — was classified as a missing asset. The rule is now
 * membership in CONTENT_TYPES, the set of extensions this server has an
 * explicit type for. That is narrower than "could have served": the serving
 * path below falls back to application/octet-stream, so an unlisted extension
 * sitting in dist/ is still returned. The classifier only runs when no file
 * matched, so the two never disagree in practice — but note the coupling.
 * CONTENT_TYPES now does double duty as MIME map *and* asset classifier, so
 * adding a new asset type to the bundle without adding it here silently
 * changes the missing-file answer from an honest 404 to index.html plus a MIME
 * error.
 *
 * /plugins/ is exempt unconditionally, because extension membership does not
 * settle the question for client routes. Plugin page ids are unconstrained
 * (`z.string().min(1)` in both PageSchemaSchema and PagePayloadSchema), so a
 * page id ending `.map` or `.json` would land back in the same production 404
 * this function exists to fix. Nothing under /plugins/ is ever a file: this
 * server serves apps/web/dist only, and Vite emits every bundle asset under
 * /assets/. The namespace is a client route, full stop.
 *
 * Lowercased before the lookup because extname preserves case: without it
 * `/assets/APP.JS` misses the map and gets index.html, which is the MIME-error
 * failure above in its harder-to-spot direction.
 */
export function shouldServeIndex(urlPath) {
  if (urlPath === "/plugins" || urlPath.startsWith("/plugins/")) return true;
  const ext = extname(urlPath).toLowerCase();
  if (ext === "") return true;
  return !CONTENT_TYPES.has(ext);
}

function send(res, status, headers, stream) {
  res.writeHead(status, headers);
  if (stream) stream.pipe(res);
  else res.end();
}

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    return;
  }

  const urlPath = new URL(req.url, `http://${req.headers.host ?? "localhost"}`).pathname;
  const filePath = safePath(urlPath);
  if (filePath === null) {
    send(res, 400, { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  const target = await stat(filePath).catch(() => null);
  const found = target?.isFile() ? filePath : null;

  if (found) {
    const ext = extname(found);
    // Vite content-hashes everything under /assets, so those are safe to cache
    // forever. index.html must not be, or clients pin themselves to a stale
    // bundle across deploys.
    const cacheControl = urlPath.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    send(res, 200, {
      "content-type": CONTENT_TYPES.get(ext) ?? "application/octet-stream",
      "content-length": target.size,
      "cache-control": cacheControl,
    }, req.method === "HEAD" ? null : createReadStream(found));
    return;
  }

  // SPA fallback, but only for what looks like a client-side route — see
  // shouldServeIndex for what "looks like" means and why an extension alone
  // does not decide it.
  if (shouldServeIndex(urlPath)) {
    const indexPath = join(ROOT, "index.html");
    const index = await stat(indexPath).catch(() => null);
    if (index?.isFile()) {
      send(res, 200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": index.size,
        "cache-control": "no-cache",
      }, req.method === "HEAD" ? null : createReadStream(indexPath));
      return;
    }
  }

  send(res, 404, { "content-type": "text/plain; charset=utf-8" });
});

/**
 * Bind only when run as a program, not when imported. `shouldServeIndex` is
 * unit-tested (test/serve-spa-fallback.test.ts), and without this guard the
 * import would start a listener on PORT inside the test worker — which either
 * collides with a real server or leaves the run hanging on an open handle.
 *
 * `createServer` above is left unguarded on purpose: it allocates an object and
 * binds nothing, so it costs an import nothing.
 *
 * The container's CMD runs this file directly, so argv[1] is this file and the
 * guard is true there. If it were ever wrong the web process would start,
 * serve nothing and exit 0 — silent, and worse than the bug this file was
 * changed to fix — so it is checked by hand against `node apps/web/serve.mjs`.
 */
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`web: serving ${ROOT} on 0.0.0.0:${PORT}`);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => { server.close(() => process.exit(0)); });
  }
}
