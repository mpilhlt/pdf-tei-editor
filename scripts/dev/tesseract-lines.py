#!/usr/bin/env python3
"""
Offline experiment for fine-tuning Tesseract on reviewed lines (#959).

Commands:

  fetch  Download the training lines of the reviewed segmentation documents
         (GET /api/v1/ocr/training-lines, admins only) as a zip archive. Authenticates with the
         personal access token in API_TOKEN, at API_BASE_URL (default http://localhost:8000).
  split  Unpack the archive into <out>/train and <out>/eval (tesstrain's layout: .png + .gt.txt),
         holding out a share of the documents (not lines) for evaluation. Corrected lines can be
         repeated in the training set.
  eval   Recognize the evaluation lines with one or more models and report the character and word
         error rates, overall and on the corrected lines, and the most frequent confusions.

Example:

  set -a && source .env && set +a
  uv run python scripts/dev/tesseract-lines.py fetch -o lines.zip
  uv run python scripts/dev/tesseract-lines.py split lines.zip gt
  uv run python scripts/dev/tesseract-lines.py eval gt/eval -m deu -m best/deu

Fine-tuning with tesstrain (https://github.com/tesseract-ocr/tesstrain), starting from the
tessdata_best model, then evaluating the result:

  make -C tesstrain training MODEL_NAME=deu_pte START_MODEL=deu TESSDATA=<dir with best deu.traineddata> \
      GROUND_TRUTH_DIR=$PWD/gt/train MAX_ITERATIONS=10000
  uv run python scripts/dev/tesseract-lines.py eval gt/eval -m best/deu -m deu_pte --tessdata-dir <dir with all models>

Requires the `tesseract` program; `--tessdata-dir` points to the folder of the models (with the
best models in `best/` like the OCRmyPDF plugin's link folder `data/plugins/ocrmypdf/tessdata/`).
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path


# ── fetch ────────────────────────────────────────────────────────────


def fetch(args: argparse.Namespace) -> None:
    base_url = os.environ.get("API_BASE_URL", "http://localhost:8000").rstrip("/")
    token = os.environ.get("API_TOKEN")
    if not token:
        sys.exit("API_TOKEN is not set (set -a && source .env && set +a)")
    login = urllib.request.Request(f"{base_url}/api/v1/auth/token-login", method="POST", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(login) as response:
        data = json.load(response)
    session_id = data.get("sessionId") or data.get("session_id")
    query = urllib.parse.urlencode({"collection": args.collection} if args.collection else {})
    request = urllib.request.Request(f"{base_url}/api/v1/ocr/training-lines?{query}", headers={"X-Session-ID": session_id})
    started = time.monotonic()
    print("Collecting the lines on the server (this takes a while for many documents) ...", file=sys.stderr)
    with urllib.request.urlopen(request, timeout=3600) as response, open(args.output, "wb") as out:
        shutil.copyfileobj(response, out)
    with zipfile.ZipFile(args.output) as archive:
        count = sum(1 for name in archive.namelist() if name.endswith(".gt.txt"))
    print(f"{count} lines saved to {args.output} in {time.monotonic() - started:.0f} s", file=sys.stderr)


# ── split ────────────────────────────────────────────────────────────


def held_out(doc_id: str, share: float) -> bool:
    """Whether a document belongs to the evaluation set: fixed by the hash of its id."""
    return int(hashlib.sha256(doc_id.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF < share


def split(args: argparse.Namespace) -> None:
    out = Path(args.out)
    counts: Counter[str] = Counter()
    with zipfile.ZipFile(args.archive) as archive:
        for name in archive.namelist():
            if not name.endswith(".json"):
                continue
            entry = json.loads(archive.read(name))
            stem = name[: -len(".json")]
            target = "eval" if held_out(entry["doc_id"], args.held_out) else "train"
            folder = out / target
            folder.mkdir(parents=True, exist_ok=True)
            base = stem.replace("lines/", "").replace("/", "__")
            copies = args.oversample_corrected if target == "train" and entry["corrected"] else 1
            for copy in range(copies):
                suffix = f"-{copy}" if copy else ""
                (folder / f"{base}{suffix}.png").write_bytes(archive.read(f"{stem}.png"))
                (folder / f"{base}{suffix}.gt.txt").write_bytes(archive.read(f"{stem}.gt.txt"))
            if target == "eval":
                (folder / f"{base}.json").write_bytes(archive.read(name))
            counts[target] += 1
            counts[f"{target}-corrected"] += int(entry["corrected"])
    print(f"train: {counts['train']} lines ({counts['train-corrected']} corrected, repeated {args.oversample_corrected}x)")
    print(f"eval:  {counts['eval']} lines ({counts['eval-corrected']} corrected)")


# ── eval ─────────────────────────────────────────────────────────────


def levenshtein(a: str | list[str], b: str | list[str]) -> int:
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, start=1):
        current = [i]
        for j, y in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def confusions(truth: str, read: str) -> list[tuple[str, str]]:
    """(truth, read) pairs of the replaced, deleted and inserted characters of an alignment."""
    pairs: list[tuple[str, str]] = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, truth, read, autojunk=False).get_opcodes():
        if op != "equal":
            pairs.append((truth[i1:i2], read[j1:j2]))
    return pairs


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


@dataclass
class Score:
    chars: int = 0
    char_errors: int = 0
    words: int = 0
    word_errors: int = 0
    lines: int = 0

    def add(self, truth: str, read: str) -> None:
        self.chars += len(truth)
        self.char_errors += levenshtein(truth, read)
        self.words += len(truth.split())
        self.word_errors += levenshtein(truth.split(), read.split())
        self.lines += 1

    def cer(self) -> str:
        return f"{100 * self.char_errors / self.chars:.2f}%" if self.chars else "-"

    def wer(self) -> str:
        return f"{100 * self.word_errors / self.words:.2f}%" if self.words else "-"


def recognize(image: Path, model: str, tessdata_dir: str | None, psm: int) -> str:
    command = ["tesseract", str(image), "stdout", "-l", model, "--psm", str(psm)]
    if tessdata_dir:
        command[1:1] = ["--tessdata-dir", tessdata_dir]
    result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, "OMP_THREAD_LIMIT": "1"}, check=False)
    if result.returncode != 0:
        sys.exit(f"tesseract failed for {image} with model {model}: {result.stderr.strip()}")
    return normalize(result.stdout)


def evaluate(args: argparse.Namespace) -> None:
    folder = Path(args.dir)
    images = sorted(folder.glob("*.png"))
    if not images:
        sys.exit(f"No line images in {folder}")
    truths = {image: normalize(image.with_name(image.stem + ".gt.txt").read_text("utf-8")) for image in images}
    corrected: set[Path] = set()
    for image in images:
        meta = image.with_name(image.stem + ".json")
        if meta.exists() and json.loads(meta.read_text("utf-8")).get("corrected"):
            corrected.add(image)
    rows: list[str] = []
    top: dict[str, list[tuple[tuple[str, str], int]]] = {}
    for model in args.model:
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            reads = dict(zip(images, pool.map(lambda image: recognize(image, model, args.tessdata_dir, args.psm), images)))
        seconds = time.monotonic() - started
        total, fixed = Score(), Score()
        counter: Counter[tuple[str, str]] = Counter()
        for image in images:
            total.add(truths[image], reads[image])
            if image in corrected:
                fixed.add(truths[image], reads[image])
            counter.update(confusions(truths[image], reads[image]))
        rows.append(f"| {model} | {total.lines} | {total.cer()} | {total.wer()} | {fixed.lines} | {fixed.cer()} | {seconds / len(images) * args.jobs:.2f} s |")
        top[model] = counter.most_common(args.top)
    print("| Model | Lines | CER | WER | Corrected lines | CER corrected | Time per line |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    print("\n".join(rows))
    for model in args.model:
        print(f"\nMost frequent confusions of {model} (printed → read):")
        for (truth, read), count in top[model]:
            print(f"  {count:>5}  {truth or '∅'!r} → {read or '∅'!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("fetch", help="Download the training lines as a zip archive")
    p.add_argument("-o", "--output", default="training-lines.zip")
    p.add_argument("--collection", help="Only documents of this collection")
    p.set_defaults(func=fetch)

    p = commands.add_parser("split", help="Unpack into train/ and eval/ by document")
    p.add_argument("archive")
    p.add_argument("out")
    p.add_argument("--held-out", type=float, default=0.1, help="Share of the documents for evaluation (default 0.1)")
    p.add_argument("--oversample-corrected", type=int, default=3, help="Copies of each corrected line in train/ (default 3)")
    p.set_defaults(func=split)

    p = commands.add_parser("eval", help="Character and word error rates of models on line images")
    p.add_argument("dir")
    p.add_argument("-m", "--model", action="append", required=True, help="Tesseract model (-l value), repeatable: deu, best/deu, deu_pte")
    p.add_argument("--tessdata-dir", help="Folder of the models")
    p.add_argument("--psm", type=int, default=7, help="Page segmentation mode (default 7: a single line)")
    p.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 1)
    p.add_argument("--top", type=int, default=15, help="Number of confusions to list (default 15)")
    p.set_defaults(func=evaluate)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
