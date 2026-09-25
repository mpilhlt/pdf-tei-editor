# scripts/

Tooling that is never shipped in the production image.

- `build/` — build pipeline (`npm run build`), code generators, icon/template/PDF.js bundling
- `dev/` — developer helpers: `debug-api.js`, `inspect-tei.py`, `reset-application.py`, API doc generation, branch utilities
- `deploy/` — container build/run/deploy (`container.js`, `deploy.js`), nginx and cron setup, deployment benchmarks

Runtime and admin scripts live in `bin/`.
