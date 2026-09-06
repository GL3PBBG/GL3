# Dynamic-load e2e smoke

CAUTION: uses the GL3 checkout's Postgres/Redis. Do NOT run while any test
suite is running anywhere on the machine. Use a spare database migrated to
head, never `gl3` itself.

Record what you actually ran, with the version, under a dated heading below.

- [ ] 1. Build + pack here:      `npm run build && npm pack`   → `gl3-plugins-__ID__-0.1.0.tgz`
- [ ] 2. Stage an install dir:   `mkdir -p /tmp/__ID__-plugins && cp .npmrc /tmp/__ID__-plugins/ && npm i --prefix /tmp/__ID__-plugins ./gl3-plugins-__ID__-0.1.0.tgz`
       (without the `.npmrc`, `@gl3/plugin-sdk` 404s against npmjs.org)
- [ ] 3. Boot the built engine:  `DATABASE_URL=postgres://gl3:gl3@localhost:5432/<spare-db> REDIS_URL=redis://localhost:6379 PLUGIN_DIR=/tmp/__ID__-plugins PLUGIN_PACKAGES=@gl3-plugins/__ID__ node apps/server/dist/index.js`
- [ ] 4. Expect boot logs: migrations applied, routes registered for `__ID__`.
- [ ] 5. Drive one real round trip through the API and note the result here.

## 0.1.0 smoke (date)

(not yet run)
