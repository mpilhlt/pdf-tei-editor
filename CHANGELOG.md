# Changelog

Maintained automatically by [semantic-release](https://github.com/semantic-release/semantic-release) from Conventional Commit messages. Releases up to and including **v0.57.2** are listed only on the [GitHub Releases page](https://github.com/mpilhlt/pdf-tei-editor/releases).

# [0.60.0](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.59.0...v0.60.0) (2026-09-12)


### Bug Fixes

* disable merge/diff controls on read-only documents ([292449c](https://github.com/mpilhlt/pdf-tei-editor/commit/292449c8a5b6a8b6b3c66c4a5429e33042ad3f8c)), closes [#410](https://github.com/mpilhlt/pdf-tei-editor/issues/410)
* **grobid:** enforce per-document write access on reload-feature-file ([3705b72](https://github.com/mpilhlt/pdf-tei-editor/commit/3705b724ff66ed1150743845d01fb3f6a30dbc70))
* redesign user menu with person icon and fullname header ([bb375a7](https://github.com/mpilhlt/pdf-tei-editor/commit/bb375a75aae785156cb0ab81d7a1b7b07518ca48)), closes [#403](https://github.com/mpilhlt/pdf-tei-editor/issues/403)


### Features

* add PDF-TEI favicon with dev/production color variants ([f643e96](https://github.com/mpilhlt/pdf-tei-editor/commit/f643e96e8143415cab0c255c0d162a2d314c9b3e))
* show logged-in username in browser tab title ([3779d99](https://github.com/mpilhlt/pdf-tei-editor/commit/3779d99b664237b6fcf82dd6f21196dc53b9db5e))

# [0.59.0](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.58.0...v0.59.0) (2026-09-12)


### Bug Fixes

* apply gold-standard marking when saving a new copy ([907b74c](https://github.com/mpilhlt/pdf-tei-editor/commit/907b74ce58b0330d10a91a4c371ca5d3df99c372)), closes [#462](https://github.com/mpilhlt/pdf-tei-editor/issues/462)
* recognize wildcard admin role in update-metadata plugin auth ([b801681](https://github.com/mpilhlt/pdf-tei-editor/commit/b801681648041a7101fbed72377d553c9f952ad8))
* **tests:** patch get_grobid_server_url at its import site in routes.py ([bc39aa9](https://github.com/mpilhlt/pdf-tei-editor/commit/bc39aa92ae3ce2556abb3c6cef2c077e556d8502))


### Features

* add prefix icons to backend plugin menu items ([ea87872](https://github.com/mpilhlt/pdf-tei-editor/commit/ea878724b1347f7dbb6b7c9ba15f59238e5950a7))
* **grobid:** add reviewer confirmation flow to reload GROBID feature file ([599d93b](https://github.com/mpilhlt/pdf-tei-editor/commit/599d93b217274b4e7b60b09d96a0a3ff54e601e3))
* ignore leading/trailing whitespace-only line diffs in merge view ([d5af677](https://github.com/mpilhlt/pdf-tei-editor/commit/d5af6775396f43c46f664a2234c762490ffd9591)), closes [#461](https://github.com/mpilhlt/pdf-tei-editor/issues/461)

# [0.58.0](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.57.4...v0.58.0) (2026-09-12)


### Bug Fixes

* **deps:** upgrade pdfjs-dist to v6.3.289 ([6787c60](https://github.com/mpilhlt/pdf-tei-editor/commit/6787c60788e27efc7b116be0621b7f931add00e0)), closes [#450](https://github.com/mpilhlt/pdf-tei-editor/issues/450) [#434](https://github.com/mpilhlt/pdf-tei-editor/issues/434)
* resolve pytest collection errors in full test suite run ([1148675](https://github.com/mpilhlt/pdf-tei-editor/commit/1148675ed8c9ecc5c9838242f7b1b3b25d5d1002))
* **tests:** stop smart-test-runner tests from mutating real git branches ([6455d57](https://github.com/mpilhlt/pdf-tei-editor/commit/6455d57bcdd55c27f36e3e6c90faee0093d400d1))


### Features

* add Collection Coverage Overview plugin ([329c8fb](https://github.com/mpilhlt/pdf-tei-editor/commit/329c8fb919e4185fa482a169f919bbb042985c1a))

## [0.57.4](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.57.3...v0.57.4) (2026-09-11)


### Bug Fixes

* **annotation:** avoid overlapping XML when tagging a partially-tagged selection ([a56ff7b](https://github.com/mpilhlt/pdf-tei-editor/commit/a56ff7bade102646fcfd3113625dc6e6b6763e0d)), closes [#443](https://github.com/mpilhlt/pdf-tei-editor/issues/443)
* **annotation:** prevent editing read-only documents in visual mode ([00ab43e](https://github.com/mpilhlt/pdf-tei-editor/commit/00ab43e91b90bf296be3fc1acf1024905b8b92a4)), closes [FiledataPlugin#saveXml](https://github.com/FiledataPlugin/issues/saveXml) [#420](https://github.com/mpilhlt/pdf-tei-editor/issues/420)
* **deps:** pin jsdom below v30 to restore Node 20 compatibility ([a01fbe4](https://github.com/mpilhlt/pdf-tei-editor/commit/a01fbe4ec4daf9c32a462c3f414b3e6456087c96))

## [0.57.3](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.57.2...v0.57.3) (2026-09-10)


### Bug Fixes

* use readable colours for annotation badge palette ([e332c83](https://github.com/mpilhlt/pdf-tei-editor/commit/e332c836edc30d5ba78618e97a3d3d4e5f7343ab)), closes [#444](https://github.com/mpilhlt/pdf-tei-editor/issues/444)
