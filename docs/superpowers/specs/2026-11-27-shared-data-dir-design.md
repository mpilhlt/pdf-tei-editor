# Shared data directory and tessdata_best download (#959 step 0)

## Intent

Downloading the `tessdata_best` models (~127 MB) into every image and installation is wasteful. Data that the application downloads or produces itself and that is not specific to one installation (downloaded models, later fine-tuned models shared by all instances) is stored once per host, in a directory outside the deployment and the container. Core hands out named subdirectories of it; core and plugins use them.

## Goals

- App-wide setting for the shared directory, and an API that returns named subdirectories.
- Safe concurrent use by several workers and several installations (possibly of different versions) on the same host.
- `tessdata_best` models are downloaded into it at startup instead of at image build time.

## Non-goals

- The Debian `tesseract-ocr-<lang>` packages keep providing the fast models; nothing is moved out of the image.
- No registry or admin UI listing the named directories, no cleanup of old versions.
- No on-demand download per OCR run, no admin download action.

## Anti-goals

- Instance-specific data (user data, the instance's own trained models before they are shared) must not go into the shared directory.

## Approaches (decided)

How Tesseract finds models outside its system data folder:

1. **Chosen:** an instance-local link folder `data/plugins/ocrmypdf/tessdata/` with symlinks to every entry of the system tessdata folder (fast models, `configs/`, `tessconfigs/`) plus `best` → the shared best-model directory; the plugin sets `TESSDATA_PREFIX` to it once at startup. OCRmyPDF workers and the footnote-marker recognizer inherit it. Works in Docker and locally; #959 already plans this folder for fine-tuned models.
2. Fixed symlink in the image to a fixed mount point: container-only.
3. Writing into the system tessdata folder at runtime: needs root, mixes our files with Debian's.

When models are downloaded: (a) at startup for a configured list of languages (chosen); on first use and admin-only were rejected.

## Design

### Core

- `Settings.SHARED_DATA_DIR` (env), property `shared_data_dir`, default `data_root / "shared"`.
- `fastapi_app/lib/core/shared_data.py`:
  - `get_shared_data_dir(name: str) -> Path`: validates `name` (slash-separated segments of `[A-Za-z0-9._-]`, no `.`/`..`), creates and returns `shared_data_dir / name`. Convention: names start with the owner (`tesseract/...`) and contain a version.
  - `download_shared_file(url: str, target: Path, timeout: float) -> bool`: returns False if `target` exists; otherwise takes an exclusive non-blocking `fcntl` lock on `target + ".lock"` (another process downloading → returns False), downloads to a temp file in the same directory and renames it into place. Raises on download errors.
- Both exported in `fastapi_app/plugin_api.py`.

### OCRmyPDF plugin

- Config `ocr.tesseract.best_languages` from env `TESSERACT_BEST_LANGS` (space- or comma-separated Tesseract codes), default empty.
- `initialize()`:
  1. Determine the system tessdata folder from the first line of `tesseract --list-langs` (before changing `TESSDATA_PREFIX`).
  2. Rebuild the link folder: symlink each entry of the system folder and `best` → `get_shared_data_dir("tesseract/tessdata_best-4.1.0")`. Built in a temp folder and swapped in with a rename, so concurrent workers do not see a half-built folder.
  3. Set `os.environ["TESSDATA_PREFIX"]`.
  4. Start a daemon thread that downloads the missing configured best models from `https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/<lang>.traineddata`; failures are logged as warnings. After each finished file the engine's model cache is invalidated.
- If setting up the link folder fails, the plugin logs a warning and works with the system models only.
- The engine gets `invalidate_models()` to reset the cached `tesseract --list-langs` result.

### Docker

- The `RUN` that downloads best models is removed. `TESSERACT_BEST_LANGS` becomes `ENV TESSERACT_BEST_LANGS="${TESSERACT_LANGS}"`.
- Docs: deployment guide shows mounting a host directory as `SHARED_DATA_DIR` (e.g. `-v /opt/pte-shared:/app/shared -e SHARED_DATA_DIR=/app/shared`); without the mount, the models are stored in the data volume.

### Tests

- `shared_data`: name validation, directory creation, atomic download (with a local HTTP server or patched opener), skip when present or locked.
- Plugin: link folder contents with a fake system folder, `best` link target, download list parsing.

## Left to the builder

- Exact module for the plugin-side setup (`tessdata.py` in the plugin).
- Download via `urllib.request` (no new dependency).
