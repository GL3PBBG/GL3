# Repository layout

| Path | What it is |
|---|---|
| `apps/server` | Fastify API, WS gateway, BullMQ workers, core Drizzle schema (`src/db/schema/`) and migrations (`drizzle/`), integration tests |
| `apps/web` | React 18 + Vite client |
| `apps/migrate` | V2 → GL3 migration CLI |
| `packages/shared` (`@gl3/shared`) | Zod event contracts and DTOs, shared by server and web; published on `npm.gl3.dev` |
| `packages/plugin-sdk` (`@gl3/plugin-sdk`) | The SDK third-party plugins build against; also published |
| `packages/plugins/*` | The twenty bundled gameplay plugins (combat, detectives, travel, gangs, casino, ...) |
| `examples/` | Example plugin packages |
| `scripts/` | Repo maintenance scripts (`plugins:generate`, stale test-clone cleanup, ...) |
| `docs/` | Working notes: `STATUS.md` (project status), `ENGINEERING-NOTES.md` (why the code looks the way it does), `superpowers/` (agent material). Not this site |
| `manual/` | This documentation site (VitePress) |
| `CLAUDE.md` | Working conventions and the six rules; the short version of ENGINEERING-NOTES |
| `SPEC.md` | What to build |

## Conventions at a glance

- TypeScript strict, ESM only; relative imports carry a `.js` extension. No `any`
  in `packages/*`.
- Plugin tables: `p_<plugin>_*`; core tables unprefixed. UUIDv7 primary keys.
- Money is `bigint` in Postgres and TypeScript, a decimal string on the wire.
- Plugin-to-plugin coupling: read-only exported helpers only.
- `@gl3/shared` / `@gl3/plugin-sdk` changes to the public surface need a version
  bump plus a republish to `npm.gl3.dev` (additive changes are a patch under `0.x`).
- New test files: registered explicitly in `vitest.workspace.ts`.
- Conventional Commits.
