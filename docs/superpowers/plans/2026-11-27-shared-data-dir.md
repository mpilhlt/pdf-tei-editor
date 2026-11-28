# Shared Data Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-wide shared data directory with named subdirectories, used to download the `tessdata_best` models once per host at startup instead of baking them into the image.

**Architecture:** Core resolves `SHARED_DATA_DIR` and hands out validated named subdirectories plus an atomic, lock-guarded download helper. The OCRmyPDF plugin builds an instance-local tessdata link folder (system models + `best` → shared folder), sets `TESSDATA_PREFIX` once, and downloads configured best models in a background thread.

**Tech Stack:** Python 3.13, FastAPI, `urllib.request`, `fcntl`, Node deploy scripts.

**Spec:** `docs/superpowers/specs/2026-11-27-shared-data-dir-design.md` (issue #964)

## Global Constraints

- Shared dir default: `data_root / "shared"`; env `SHARED_DATA_DIR`.
- Best-model folder name: `tesseract/tessdata_best-4.1.0`; URL `https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/<lang>.traineddata`.
- Config key `ocr.tesseract.best_languages`, env `TESSERACT_BEST_LANGS`, default empty; Docker image sets `ENV TESSERACT_BEST_LANGS="${TESSERACT_LANGS}"`.
- Link folder: `settings.plugins_data_dir / "ocrmypdf" / "tessdata"`.
- Debian packages keep providing the fast models.
- Python: precise type annotations, single-line string literals.

## Review Focus

- Two workers start at once: link folder swap must not fail or leave a half-built folder → test building twice in a row and over an existing folder.
- Download interrupted: no partial `.traineddata` left under the final name → test a failing opener leaves no target file.
- Model appears while the server runs: "best" option must show up without restart → test `invalidate_models()` makes `get_options()` include `model`.
- `SHARED_DATA_DIR` not writable / offline host: plugin still registers and OCR works with fast models → test setup failure is logged, engine still registered.
- Malicious/odd names (`../x`, `a//b`, absolute paths) → rejected with ValueError.

---

### Task 1: Core shared data API

**Files:**
- Modify: `fastapi_app/config.py` (add `SHARED_DATA_DIR: str = ""`, property `shared_data_dir`)
- Create: `fastapi_app/lib/core/shared_data.py`
- Modify: `fastapi_app/plugin_api.py` (export both functions)
- Test: `tests/unit/fastapi/test_shared_data.py`

**Interfaces:**
- Produces: `get_shared_data_dir(name: str) -> Path`; `download_shared_file(url: str, target: Path, timeout: float = 300) -> bool` (True if downloaded, False if present or locked by another process).

- [ ] Tests: `test_name_validation` (`"../x"`, `"/abs"`, `"a//b"`, `""`, `"a/./b"` raise ValueError; `"tesseract/tessdata_best-4.1.0"` ok), `test_dir_created_under_setting` (patch settings, dir exists), `test_default_under_data_root`, `test_download_atomic` (patched `urllib.request.urlopen` returning bytes → file content; failing opener → no target, no temp left, exception raised), `test_skip_existing`, `test_skip_when_locked` (hold `fcntl.flock` on `<target>.lock` in test → returns False).
- [ ] Run, see fail; implement; run, see pass.

### Task 2: OCRmyPDF tessdata setup

**Files:**
- Create: `fastapi_app/plugins/ocrmypdf/tessdata.py`
- Modify: `fastapi_app/plugins/ocrmypdf/engine.py` (`invalidate_models()`), `plugin.py` (`__init__` reads config; `initialize()` calls setup + starts downloader)
- Test: `fastapi_app/plugins/ocrmypdf/tests/test_tessdata.py`

**Interfaces:**
- Consumes: Task 1 functions.
- Produces: `BEST_MODELS_DIR_NAME = "tesseract/tessdata_best-4.1.0"`; `system_tessdata_dir() -> Path | None` (parses `tesseract --list-langs` first line); `build_link_dir(system_dir: Path, best_dir: Path, link_dir: Path) -> None` (temp sibling + rename swap); `parse_languages(value: str | list[str] | None) -> list[str]`; `download_best_models(languages: list[str], best_dir: Path, on_downloaded: Callable[[], None]) -> None`.

- [ ] Tests: link folder has a symlink per system entry and `best` → best_dir; rebuild over existing folder works; `parse_languages("eng deu")`, `"eng,deu"`, `["eng"]`, `None`; download skips present files and calls callback once per new file (patched `download_shared_file`); failures logged, loop continues; `engine.invalidate_models()` makes `model` option appear after a best model is listed.
- [ ] Plugin init: on any setup exception log warning and keep system models; on success set `os.environ["TESSDATA_PREFIX"]` and start a daemon thread if languages configured.

### Task 3: Docker, deploy, docs

**Files:** `Dockerfile`, `scripts/deploy/container.js` (`--shared-dir <dir>` → mount `/app/shared`, env `SHARED_DATA_DIR=/app/shared`, deploy and start commands), `.env.development`, `.env.production`, `.env.deploy.example.org`, `.env.deploy.demo.localhost` (document `SHARED_DATA_DIR` / `DEPLOY_SHARED_DIR`), `docs/user-manual/docker-deployment.md`, `fastapi_app/plugins/ocrmypdf/README.md`, `docs/code-assistant/backend-plugins.md` (shared data API), `docs/code-assistant/architecture-backend.md` if it lists data dirs.

- [ ] Remove the best-model `RUN`; add the `ENV`.
- [ ] Verify `podman build --target base` and a container run with a mounted shared dir downloads `deu` and lists `best/deu`.

### Task 4: Verify and ship

- [ ] `npm run test:unit`, `npm run test:e2e`; commit; push; update PR #963 description; reference #964.
