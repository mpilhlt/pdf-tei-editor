# Favicon Design — Design Spec

Date: 2026-09-12
Status: Approved for planning

## Problem

The app has no real favicon — `app/web/favicon.ico` is a generic default and
`index.html` doesn't even link it explicitly. There's also no way to tell a
production tab from a dev-mode tab (`?dev` query param, see
`app/web/bootstrap.js:7`) at a glance in the browser tab bar.

## Decision

Icon concept: **"Tag Page"** — a rounded-square tile containing a
folded-corner document silhouette with a small `<>` bracket glyph inside.
Chosen over two alternatives (plain "dog-ear" page with no glyph; a
literal "two pages + arrow" scene) presented as an SVG mockup — this one
balances discernibility at 16×16 with being specifically about
PDF-to-markup conversion, rather than reading as a generic file icon.

One shape, two color variants, switched at runtime by existing mode
detection — no second design:

- **Production**: `#2f5fd8` (matches the app's existing Shoelace default
  blue accent)
- **Development** (`?dev` present): `#d9860f` (amber — conventional
  "in progress / use caution" signal)

## Assets

- Master vector: `app/web/favicon.svg` (or per-variant
  `favicon.svg` / `favicon-dev.svg`) — single source of truth,
  hand-authored flat SVG (rect + path + two stroke chevrons), no build step
  needed.
- Raster fallbacks generated from the SVG: `favicon.ico` (16/32/48 multi-res)
  and `favicon-32.png` / `favicon-dev-32.png` (or similar) for browsers/
  contexts that don't support SVG favicons.
- Both `favicon.ico` and the dev variant's raster fallback ship as static
  files under `app/web/`, committed to git (not build artifacts).

## Integration

`bootstrap.js` already computes `loadFromSource` (the `?dev` flag) before
`DOMContentLoaded`. It currently only conditionally swaps stylesheets/module
source; it will also inject the appropriate `<link rel="icon">` (SVG,
with an `.ico`/`.png` `sizes`-qualified fallback link for non-SVG-favicon
browsers) pointing at the prod or dev asset variant. `index.html` itself
does not need a static `<link rel="icon">` for the SVG, since it's always
injected by bootstrap.js before paint-relevant favicon lookup — but a
static fallback `<link rel="icon" href="favicon.ico">` stays in
`index.html` as a no-JS/pre-injection safety net (defaulting to the
production variant).

## Out of scope

- No app icon / PWA manifest / apple-touch-icon — not requested, no
  manifest exists today.
- No changes to `bootstrap.js`'s dev/prod detection logic itself.
