# "Edit on GitHub" button returns 404 (#659)

## Problem

The user manual's "Edit on GitHub" button built its URL from the release tag (`https://github.com/mpilhlt/pdf-tei-editor/edit/v0.79.0/docs/index.md`). GitHub's web editor only accepts branches, so every tag URL returned 404.

## Fix

`app/src/plugins/info.js` now always points the edit URL at the `devel` branch, where documentation changes are merged. The rendered docs still load from the release tag. `docs/development/providing-help.md` describes the new behaviour.
