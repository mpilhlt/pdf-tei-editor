# GROBID Plugin

Integrates a [GROBID](https://github.com/kermitt2/grobid) server into the PDF-TEI Editor for extracting training data and full-text TEI from PDF files.

## Functionality

The plugin provides two complementary workflows:

**Training data extraction** — submits a PDF to GROBID's `/api/createTraining` endpoint, which returns a ZIP containing pre-segmented TEI files for each supported model (segmentation, header, citation, etc.). Each file is unpacked, normalized if necessary (see [Content normalization](#content-normalization) below), enriched with document metadata and a structured TEI header, and stored as a gold-standard annotation that can be reviewed and corrected in the editor.

**Full-text / reference extraction** — submits a PDF to GROBID's fulltext or references service endpoints and stores the result as a TEI document.

Extracted training data is cached per document and GROBID revision so that subsequent extractions for the same document are served from cache without re-contacting the server (see [Cache](#cache-cachepy) below). The cache is invalidated automatically when a PDF is deleted.

Reviewers can download a complete training package for a collection as a ZIP file that mirrors the `grobid-trainer/resources/dataset/` directory structure and can be dropped directly into that directory.

The plugin also registers a `split-bibl` enhancement with the TEI Wizard plugin, if available.

### Supported variants

| Variant ID | GROBID model path |
| --- | --- |
| `grobid.training.header` | `header` |
| `grobid.training.header.affiliation` | `affiliation-address` |
| `grobid.training.header.authors` | `name/header` |
| `grobid.training.header.date` | `date` |
| `grobid.training.segmentation` | `segmentation` |
| `grobid.training.references` | `citation` |
| `grobid.training.references.authors` | `name/citation` |
| `grobid.training.references.referenceSegmenter` | `reference-segmenter` |
| `grobid.training.table` | `table` |
| `grobid.training.figure` | `figure` |
| `grobid.service.fulltext` | `/api/processFulltextDocument` |
| `grobid.service.references` | `/api/processReferences` |

### Processing flavors

Flavors map to custom GROBID model variants. Supported values: `default`, `article/dh-law-footnotes`.

---

## Installation and configuration

### Prerequisites

A running GROBID instance accessible from the application server. The plugin is disabled (invisible to users) when no URL is configured.

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GROBID_SERVER_URL` | Yes | — | Base URL of the GROBID server, e.g. `http://localhost:8070` |
| `GROBID_SERVER_TIMEOUT` | No | `10` | Timeout in seconds for health and version checks |
| `GROBID_EXTRACTION_TIMEOUT` | No | `300` | Timeout in seconds for extraction requests (PDF processing can be slow) |
| `GROBID_DISABLE_CACHE` | No | `false` | Set to `true` to always fetch fresh data from GROBID, bypassing the training data cache |

These map to the config keys `plugin.grobid.server.url`, `plugin.grobid.server.timeout`, `plugin.grobid.extraction.timeout`, and `plugin.grobid.cache.disabled`.

### Cache location

Raw GROBID output (the ZIP returned by `/api/createTraining`) is cached at:

```text
data/plugins/grobid/extractions/{doc_id}_{grobid_revision}/
```

The directory is created automatically. To force a fresh extraction for a document, delete its cache directory, set `GROBID_DISABLE_CACHE=true` to disable caching globally, or use the `force_refresh=true` query parameter on the download endpoint.

---

## Admin reference

### Diagnostics endpoint

`GET /api/plugins/grobid/diagnostics` — admin only. Runs layered connectivity checks and returns a JSON report useful for distinguishing between general network outages, DNS failures, TLS issues, and GROBID-specific problems.

**Authentication:** session ID via `X-Session-ID` header or `session_id` query parameter. Requires admin role.

**Checks performed (in order):**

| Check | What it tells you |
| --- | --- |
| `environment` | Python/platform info, configured GROBID URL, timeout, proxy env vars |
| `dns_resolution:<host>` | Whether the server's DNS resolver can reach the GROBID hostname |
| `tcp_connect:<host>:443` | Whether a TCP socket can reach port 443 (firewall / routing) |
| `tls_handshake:<host>:443` | Whether TLS completes (cert / SNI issues) |
| `internet_access:1.1.1.1` | Whether the server has general outbound HTTPS independent of the GROBID host |
| `grobid_health` | Full GROBID `/api/health` request using the configured timeout |

**Reading the results:**

- `dns_resolution` fails → DNS is broken on the server (no internet or missing resolver config)
- `tcp_connect` fails but DNS succeeds → routing or firewall blocks outbound HTTPS
- `tls_handshake` fails but TCP succeeds → TLS/SNI issue specific to that host
- `internet_access:1.1.1.1` succeeds but `grobid_health` fails → problem is specific to the GROBID host (overloaded, sleeping HF Space, etc.)
- Both `internet_access` and `grobid_health` fail → the server has no outbound internet

**Example (using `bin/debug-api.js`):**

```bash
# Local instance
node bin/debug-api.js GET /api/plugins/grobid/diagnostics

# Remote instance with separate credentials
node bin/debug-api.js --env-path .env.remote GET /api/plugins/grobid/diagnostics
```

### Cancel in-progress download

`POST /api/plugins/grobid/cancel/{progress_id}` — cancels a running training-package download that was started with progress tracking enabled.

---

## Developer reference

### Extractor (`extractor.py`)

`GrobidTrainingExtractor` implements `BaseExtractor`. The `extract()` method:

1. Selects a handler based on `variant_id` prefix (`grobid.training.*` → `TrainingHandler`, `grobid.service.fulltext` → `FulltextHandler`, `grobid.service.references` → `ReferencesHandler`).
2. Checks the GROBID health endpoint before proceeding.
3. For training variants: checks the per-document cache, fetches from GROBID and caches on miss.
4. Applies content normalization (see below).
5. Enriches with a structured TEI header (document metadata, `encodingDesc` with model/flavor/variant-id labels, `revisionDesc`).
6. Returns the serialized TEI document.

### Content normalization

Some GROBID models (currently `header.affiliation`, `header.authors`, `header.date`) place their training content inside `<teiHeader>` rather than `<text>`. The editor's annotation tools operate on `<text>`, so the plugin relocates the content at extraction time and restores it at export time.

**On extraction (`normalize_grobid_content`):** children of the GROBID source element (e.g. `teiHeader`) are moved into the annotation target path (e.g. `text/front`), and the now-empty source element is removed.

**On download (`denormalize_grobid_content`):** the reverse operation — content is moved from the annotation path back into the GROBID path so the exported file matches the structure expected by the GROBID trainer. The app-generated `teiHeader` (containing document metadata) is removed and replaced with the reconstructed training `teiHeader`.

The mapping between GROBID path and annotation path is defined in `VARIANT_CONTENT_LOCATIONS` in `config.py`:

```python
"grobid.training.header.affiliation": {
    "grobid_path": "teiHeader",
    "annotation_path": "text/front",
},
```

Variants not listed in this mapping are passed through unchanged.

### Download route (`routes.py`)

`GET /api/plugins/grobid/download` — reviewer role required. Streams a ZIP file containing training data for all documents in a collection that have at least one gold-standard TEI file.

For each document the route:

1. Reads all gold-standard TEI files whose `variant` starts with `grobid.training.`.
2. Calls `denormalize_grobid_content` on each to reconstruct the GROBID-native structure.
3. Derives the corpus path from the TEI `encodingDesc` labels (`model`, `flavor`) via `_corpus_base_path`.
4. Fetches the raw GROBID feature file from cache (or re-fetches from GROBID if not cached), identified by matching file suffix.
5. Writes both files into the ZIP under `{collection}-training-data-{timestamp}/{model}/{flavor}/corpus/{tei,raw}/`.

The resulting ZIP mirrors `grobid-trainer/resources/dataset/` and can be unpacked directly into that directory.

**Query parameters:**

| Parameter | Default | Description |
| --- | --- | --- |
| `collection` | required | Collection ID |
| `flavor` | `default` | Processing flavor |
| `force_refresh` | `false` | Bypass cache and re-fetch from GROBID |
| `no_progress` | `true` | Suppress SSE progress events (set to `false` for UI usage) |

### Cache (`cache.py`)

Raw GROBID training packages (the ZIP from `/api/createTraining`) are stored in `data/plugins/grobid/extractions/` keyed by `{doc_id}_{grobid_revision}`. The revision string comes from GROBID's `/api/version` endpoint, ensuring that a model update invalidates existing cache entries. When the GROBID version cannot be determined, the key falls back to `{doc_id}` alone.

Cache entries are cleaned up automatically via the `file.deleted` event bus handler when a PDF is deleted and no other TEI files for the same document remain.
