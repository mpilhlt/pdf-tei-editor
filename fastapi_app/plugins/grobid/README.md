# GROBID Plugin

Provides PDF-to-TEI extraction using a [GROBID](https://github.com/grobidOrg/grobid) server, together with a trainer dashboard for managing model training, evaluation, and corpus uploads.

## Requirements

- GROBID server (required for extraction)
- Grobid Trainer service (required for training/evaluation features)

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `GROBID_SERVER_URL` | GROBID server base URL (plugin disabled if unset) | — |
| `GROBID_TRAINER_URL` | Grobid Trainer service URL | `http://localhost:8072` |

## Supported Variants

### Training Variants

Generate GROBID training data from PDFs.

| Variant ID | Description |
|---|---|
| `grobid.training.segmentation` | Document layout segmentation |
| `grobid.training.references.referenceSegmenter` | Reference zone segmentation |
| `grobid.training.references` | Individual reference parsing |

### Service Variants

Full-document processing via GROBID.

| Variant ID | Description |
|---|---|
| `grobid.service.fulltext` | Full-document extraction (header + body + bibliography) |
| `grobid.service.references` | Bibliographical reference extraction only |

## Processing Flavors

Variants can be processed with an optional flavor that selects a GROBID model fine-tuned for a specific document type:

| Flavor | Description |
|---|---|
| `default` | Standard GROBID models |
| `article/dh-law-footnotes` | DH/law documents with footnote-heavy reference styles |

## Extraction

The extractor is registered as `grobid` in the `ExtractorRegistry`. It handles:

- **Training variants**: results are cached per document and GROBID revision. Cache is stored in `data/plugins/grobid/extractions/` and is invalidated when the GROBID revision changes.
- **Service variants**: processed on demand without caching.

Extraction enriches the raw GROBID TEI output with metadata (DOI, file IDs, timestamps) and creates a proper TEI header.

Invalid XML returned by GROBID is wrapped in a recovery element rather than raising an error.

## Trainer Dashboard

Accessible at `/api/plugins/grobid/trainer/dashboard` (admin only).

### Service Status

Shows health of both the GROBID extraction server and the Grobid Trainer service (JAR build status, available models, platform info).

### Model Files

Lists trained model files for the selected model and flavor. Each file shows:

- Label (user-assigned, persisted in session storage)
- Active status
- Whether evaluation results are available
- File size and modification time

Actions:

- **Evaluate** — run an evaluation job on the selected file
- **View eval details** — open a popup with the full per-label evaluation table (accuracy, precision, recall, F1, support), with TSV copy support
- **Edit label** — assign a human-readable label
- **Delete** — remove inactive model files

The **New Training Run** panel allows starting a training job with:

| Option | Description |
|---|---|
| Mode | `0` = train only, `2` = auto train/eval split, `3` = n-fold cross-validation |
| Preset | Speed/quality preset controlling `epsilon` and `nbMaxIterations` |
| Save | Whether to make the trained model active immediately |

Available presets:

| Preset | Epsilon | Max Iterations | Use |
|---|---|---|---|
| testing | 0.001 | 200 | Quick functional test |
| development | 0.0001 | 500 | Development iteration |
| production | 1×10⁻⁷ | 2000 | Full-quality training |
| incremental | 1×10⁻⁷ | 200 | Incremental update |

### Jobs

Lists all training and evaluation jobs with live status. For running jobs:

- **Duration** shows elapsed time with a live iteration progress line: `iter N/maxIter · obj=X · err=Y% · ETA ≤Z`
- Progress is fed via a per-job SSE subscription to the trainer log stream; the full log is fetched once on job start to seed the progress state, then incremental lines arrive via SSE.
- All SSE subscriptions are closed when the page is unloaded.

Evaluation results are parsed from the job log when a job completes and cached in session storage (`grobid_eval_by_job`). Cached results are purged when the corresponding job is deleted.

### Upload Training Data

Uploads training data from a collection to the Grobid Trainer corpus. For each document in the collection the plugin either uses cached GROBID output or fetches it on demand. Supports gold-standard files (stored as primary) alongside GROBID-generated output (stored with `.generated` infix).

### Upload Batches

Lists previously uploaded batches with file counts and timestamps. Each batch can be reverted (files removed from the trainer corpus).

### End-to-End Evaluation

Runs GROBID-style end-to-end evaluation against a local dataset path in NLM/JATS or TEI format.

## Training Data Download

`GET /api/plugins/grobid/download` (requires `reviewer` or `admin` role)

Downloads a ZIP file containing training data for an entire collection. Each document is stored as `{doc_id}/{doc_id}.{variant_suffix}.tei.xml`. Supports:

- `flavor` — select processing flavor
- `force_refresh` — bypass cache
- `gold_only` — include only gold-standard files
- SSE-based progress reporting
- Cooperative cancellation via `POST /api/plugins/grobid/cancel/{progress_id}`

## Log Streaming Viewer

`GET /api/plugins/grobid/trainer/log/{job_id}` (admin only)

Standalone page that streams a job's log output in real time via SSE. Shows:

- Live log lines in a monospace terminal view
- Iteration progress and ETA (parsed from Wapiti iteration lines)
- Exit code on completion
- Evaluation result detection (stored in session storage for the comparison view)

## Evaluation Comparison Report

`GET /api/plugins/grobid/trainer/eval-report` (admin only)

Comparison view for evaluation results stored in session storage.

- **Comparison mode**: Select multiple jobs, view chosen metric (F1, precision, recall, accuracy) side-by-side with delta relative to a selected baseline.
- **Detail mode** (`?file=<filename>`): Full per-label table for a single model file (accuracy, precision, recall, F1, support all in one view). Includes a **Copy as TSV** button for use in papers/spreadsheets.

## HTTP Routes

All routes are prefixed with `/api/plugins/grobid`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/download` | reviewer+ | Download training ZIP for collection |
| POST | `/cancel/{progress_id}` | session | Cancel in-progress download |
| GET | `/trainer/dashboard` | admin | Trainer dashboard page |
| GET | `/trainer/eval-report` | admin | Evaluation comparison/detail page |
| GET | `/trainer/log/{job_id}` | admin | Job log streaming page |
| GET | `/trainer/api/extraction-health` | admin | GROBID server health |
| GET | `/trainer/api/health` | admin | Trainer service health |
| GET | `/trainer/api/jobs` | admin | List jobs |
| GET | `/trainer/api/jobs/{job_id}` | admin | Job details (includes full log) |
| POST | `/trainer/api/jobs/{job_id}/stop` | admin | Stop job |
| GET | `/trainer/api/jobs/{job_id}/stream` | admin | SSE job log stream |
| DELETE | `/trainer/api/jobs/{job_id}` | admin | Delete job |
| DELETE | `/trainer/api/jobs` | admin | Delete all finished jobs |
| GET | `/trainer/api/models/{model_name}` | admin | List model files |
| DELETE | `/trainer/api/models/{model_name}` | admin | Delete model file |
| GET | `/trainer/api/flavors` | admin | List available flavors |
| POST | `/trainer/api/train/{model_name}` | admin | Start training job |
| POST | `/trainer/api/evaluate/{eval_type}` | admin | Start evaluation job |
| GET | `/trainer/api/uploads` | admin | List upload batches |
| GET | `/trainer/api/uploads/{batch_id}` | admin | Batch details |
| POST | `/trainer/api/upload` | admin | Upload training data |
| POST | `/trainer/api/revert/{batch_id}` | admin | Revert uploaded batch |

## Caching

Training extraction results are cached in `data/plugins/grobid/extractions/` with keys of the form `{doc_id}_{grobid_revision}`. Cache entries contain the raw GROBID ZIP and a metadata JSON file. Cache is invalidated automatically when the GROBID revision changes or the source PDF is deleted.

## Events

The plugin listens to the `file_deleted` event and removes cached training data for the deleted document if no other PDF with the same `doc_id` remains.
