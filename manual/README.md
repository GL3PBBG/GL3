# GL3 manual

Developer and operator documentation, built with [VitePress](https://vitepress.dev)
and deployed to GitHub Pages by `.github/workflows/deploy-manual.yml` on every push
to `main` that touches `manual/`.

```sh
npm run docs:dev      # live-reload dev server
npm run docs:build    # static site -> manual/.vitepress/dist
npm run docs:preview  # serve the built site locally
```

One-time repo setup: Settings → Pages → Source = **GitHub Actions**.

## Conventions

- Every page is exactly one [Diátaxis](https://diataxis.fr/) type: tutorial, how-to,
  reference, or explanation.
- Docs change in the same PR as the code they describe.
- ADRs (`explanation/adr/`) are numbered, dated, immutable; supersede, don't edit.
- No em dashes.
