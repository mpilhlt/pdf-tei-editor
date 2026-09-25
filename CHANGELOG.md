# Changelog

Maintained automatically by [semantic-release](https://github.com/semantic-release/semantic-release) from Conventional Commit messages. Releases up to and including **v0.57.2** are listed only on the [GitHub Releases page](https://github.com/mpilhlt/pdf-tei-editor/releases).

# [0.64.0](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.63.1...v0.64.0) (2026-09-25)


### Bug Fixes

* **annotation-review:** report Gemini API errors as 502 instead of an unhandled 500 ([fa3890f](https://github.com/mpilhlt/pdf-tei-editor/commit/fa3890fd29184376476b90bca40cea24e2602012))
* **annotation-review:** retry Anthropic calls without temperature, report provider errors as 502 ([e8cd93f](https://github.com/mpilhlt/pdf-tei-editor/commit/e8cd93f8478b731d3cf26ca767daf85c0f3f5c86))
* **annotation-review:** show determinate progress from the first chunk via a plan request ([5f5108b](https://github.com/mpilhlt/pdf-tei-editor/commit/5f5108b01c2d8eb555b419fd98bf659c6cd29768))
* **annotation-review:** tolerate truncated or wrapped LLM output and report unusable responses ([0c33084](https://github.com/mpilhlt/pdf-tei-editor/commit/0c33084c353f8b864f509f75728cd2e58f71f865))
* **anthropic:** allow 300s for messages and do not re-send requests after a read timeout ([71d7237](https://github.com/mpilhlt/pdf-tei-editor/commit/71d7237ea1305feb9dcd914c966869c06724a61e))
* **build:** bundle icons used in ternary .icon assignments ([0c237a9](https://github.com/mpilhlt/pdf-tei-editor/commit/0c237a9239940ee4af05dbdf01191ec5c1eefdac))
* **config-editor:** don't cache the real value for masked keys after save ([f13621d](https://github.com/mpilhlt/pdf-tei-editor/commit/f13621dfa8de788d4a5ddea3ee36d8f73fec160e)), closes [originalConfig/#modifiedConfig](https://github.com/mpilhlt/pdf-tei-editor/issues/modifiedConfig)
* **inference-settings:** make no LLM requests without a session and reset on logout ([abf6aec](https://github.com/mpilhlt/pdf-tei-editor/commit/abf6aece51f21b4795ccb95e6075f92853ed1a59))
* **llm:** treat an unquoted model-filter value as one pattern; explain why Review Annotations is disabled ([e68e5c6](https://github.com/mpilhlt/pdf-tei-editor/commit/e68e5c676a921c4310dc9849462bd1e82985e52a))
* **worktrees:** base new worktrees on local HEAD, not origin/main ([911968d](https://github.com/mpilhlt/pdf-tei-editor/commit/911968d01a7aaa677caf34306e2a9feb67690465))


### Features

* **annotation-review:** add LLM-based annotation review backend plugin ([a0f1fa4](https://github.com/mpilhlt/pdf-tei-editor/commit/a0f1fa4465271c5f34124491d5ef76e4a4469d27))
* **annotation-review:** add Tools-menu trigger and diagnostics UI ([531a8d2](https://github.com/mpilhlt/pdf-tei-editor/commit/531a8d2e980a0b480e9278fad9eb8bf398f243d9))
* **annotation-review:** ask for minimal non-overlapping snippets, log kept counts, prune stale findings after edits ([c5a0f18](https://github.com/mpilhlt/pdf-tei-editor/commit/c5a0f189d391d849376007ed46f9b4139e696675))
* **annotation-review:** confirm before reviewing and show the model in the spinner ([fa0ce8a](https://github.com/mpilhlt/pdf-tei-editor/commit/fa0ce8a44d99168fd6709f84114be0fb726310fa))
* **annotation-review:** review documents chunk by chunk with a cancellable progress widget ([e924fb0](https://github.com/mpilhlt/pdf-tei-editor/commit/e924fb0c452820bed54a9ebafbac5dda391a068d))
* **inference-settings:** add default LLM model picker plugin ([d012c76](https://github.com/mpilhlt/pdf-tei-editor/commit/d012c7639db5eb382c6fa40fb0bfa26dd7533358))
* **inference-settings:** admin-only default model, per-session choice, non-free models disabled for non-admins ([2649b7a](https://github.com/mpilhlt/pdf-tei-editor/commit/2649b7a00d488514d80b8ae6de98368f1cb0c197))
* **inference-settings:** show selected model and toast on change; filter non-chat Gemini models ([a431908](https://github.com/mpilhlt/pdf-tei-editor/commit/a431908365a8263c4b9b34b94f5835381163df23))
* **llm:** add admin-configurable model allow-list filter ([b58368f](https://github.com/mpilhlt/pdf-tei-editor/commit/b58368f8b609239bb2083ed6409df2c923cbaeb5))
* **llm:** add Anthropic Claude LLM provider plugin ([0b54f75](https://github.com/mpilhlt/pdf-tei-editor/commit/0b54f75963cd00f9d21cc173c857ab1301f5e70f))
* **llm:** add core LLM provider registry and migrate Kisski onto it ([10f8450](https://github.com/mpilhlt/pdf-tei-editor/commit/10f845002faef2b7e8c26a24d0ef11147d80929e))
* **llm:** add Google Gemini LLM provider plugin ([7bb7355](https://github.com/mpilhlt/pdf-tei-editor/commit/7bb735540ae12376a7462af3386accd2a3c2bcde))
* **llm:** admin-set default model, free-model flag, include/exclude model filters ([880c88a](https://github.com/mpilhlt/pdf-tei-editor/commit/880c88a52ad724d5fc1ea2ebd1561fae6752f6af))
* **security:** harden secret handling for .env and config.json ([fd2466a](https://github.com/mpilhlt/pdf-tei-editor/commit/fd2466af6794f56d20d89d95f812ff8aaf72db00))

## [0.63.1](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.63.0...v0.63.1) (2026-09-22)


### Bug Fixes

* **ci:** grant pull-requests write permission to test job ([fe38449](https://github.com/mpilhlt/pdf-tei-editor/commit/fe3844985b7cc385002c5848f6a9097b3375a3a8))

# [0.63.0](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.62.0...v0.63.0) (2026-09-22)


### Bug Fixes

* bump scipy floor to 1.16.0 for macOS 27 dyld compatibility ([9fa2758](https://github.com/mpilhlt/pdf-tei-editor/commit/9fa2758f4a146d45c3436491b074d0a8f8477ccd))
* **deps:** bump adm-zip to 0.6.1 to fix memory allocation DoS ([eac64f5](https://github.com/mpilhlt/pdf-tei-editor/commit/eac64f5d362e1aab830f8df9d4815138d49b5d8b)), closes [#156](https://github.com/mpilhlt/pdf-tei-editor/issues/156)
* read file_id via extract_fileref() in files_save.py ([56002f9](https://github.com/mpilhlt/pdf-tei-editor/commit/56002f9fcc6fdecc71b39bdb85a9a7b4fbd875f8))
* render clickable links in dialog messages ([cf4aff8](https://github.com/mpilhlt/pdf-tei-editor/commit/cf4aff8e97a1dd4ece7f767efe41bc8131a0e755))


### Features

* add container healthcheck to deploy and podman watchdog ([80285bd](https://github.com/mpilhlt/pdf-tei-editor/commit/80285bdc64f6035f8bdefca872988f933de49a8c))
* add editorialDecl annotation-rules integration for GROBID ([c463fb8](https://github.com/mpilhlt/pdf-tei-editor/commit/c463fb8a7f7f1e35af450ebeb3a905981406964b))
* fail fast when the GROBID Hugging Face Space is not running ([ba403cb](https://github.com/mpilhlt/pdf-tei-editor/commit/ba403cb954f0f984224d497d877973730b47ec8a))

# [0.62.0](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.61.0...v0.62.0) (2026-09-16)


### Bug Fixes

* include flavor in GROBID training-data cache key ([f0197cb](https://github.com/mpilhlt/pdf-tei-editor/commit/f0197cb8c47e93968b6750083581927eb52b01c1)), closes [#480](https://github.com/mpilhlt/pdf-tei-editor/issues/480)
* move PDF into selected collection before extraction and allow deleting PDF-only docs ([87aa216](https://github.com/mpilhlt/pdf-tei-editor/commit/87aa2169093a3570e9d5e8060828b68cae28bb8f)), closes [#477](https://github.com/mpilhlt/pdf-tei-editor/issues/477)
* pre-generate backend plugin sandbox client script for production ([1154718](https://github.com/mpilhlt/pdf-tei-editor/commit/115471857272611e9f398f3c902f6f7fb5bd3eea)), closes [#478](https://github.com/mpilhlt/pdf-tei-editor/issues/478)
* prevent duplicate PDF autosearch toasts for the same node ([1773f52](https://github.com/mpilhlt/pdf-tei-editor/commit/1773f5237e56e674283a0bb7cd6f1ebd2e8ef5a3))


### Features

* add generic schema URL redirect registry, fix dead grobid schema link ([8bd6fc6](https://github.com/mpilhlt/pdf-tei-editor/commit/8bd6fc6c8f00516c3c207769cbbdff8e747eb909))
* purge GROBID training-data cache during garbage collection ([b43e7f6](https://github.com/mpilhlt/pdf-tei-editor/commit/b43e7f6d530c09a3a6374500b186a3ab21936eb9))

# [0.61.0](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.60.1...v0.61.0) (2026-09-12)


### Features

* ignore inserted/removed linebreaks between tags in merge view diff ([aca1c61](https://github.com/mpilhlt/pdf-tei-editor/commit/aca1c6129fbd639cb85b26bed3b4bc615fff7f6d)), closes [#461](https://github.com/mpilhlt/pdf-tei-editor/issues/461)

## [0.60.1](https://github.com/mpilhlt/pdf-tei-editor/compare/v0.60.0...v0.60.1) (2026-09-12)


### Bug Fixes

* annotation progress feedback (issue [#465](https://github.com/mpilhlt/pdf-tei-editor/issues/465)) ([270b503](https://github.com/mpilhlt/pdf-tei-editor/commit/270b503f2cde29df562d7a901fe694a119eb2a1c))

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
