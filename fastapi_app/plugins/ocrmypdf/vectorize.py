"""
Removal of the text layer of a PDF while keeping the appearance of the pages.

Ghostscript converts all glyphs to vector outlines (`-dNoOutputFonts`). The
pages look the same, but contain no extractable text, so OCRmyPDF can add a new
text layer without the old one getting in the way.

Ghostscript writes every glyph occurrence as a separate path, which makes the
file 20 to 50 times larger. compact_glyph_paths() stores each distinct glyph
shape once as a form XObject and replaces the occurrences with references to
it, which brings the size back to two to four times the original.

verify_outlined() checks the result before it is used: same pages, no text
left, same appearance.
"""

import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pikepdf
import pypdfium2 as pdfium
from PIL import Image, ImageChops

logger = logging.getLogger(__name__)

GS_TIMEOUT_BASE = 60
"""Ghostscript timeout in seconds, plus GS_TIMEOUT_PER_PAGE per page."""

GS_TIMEOUT_PER_PAGE = 10

GS_ARGS = [
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-dQUIET",
    "-sDEVICE=pdfwrite",
    "-dNoOutputFonts",
    "-dAutoRotatePages=/None",
    # keep images as they are: no downsampling, no lossy re-encoding
    "-dPassThroughJPEGImages=true",
    "-dPassThroughJPXImages=true",
    "-dDownsampleColorImages=false",
    "-dDownsampleGrayImages=false",
    "-dDownsampleMonoImages=false",
    "-dAutoFilterColorImages=false",
    "-dAutoFilterGrayImages=false",
    "-sColorImageFilter=FlateEncode",
    "-sGrayImageFilter=FlateEncode",
]

MAX_REMAINING_TEXT_RATIO = 0.01
"""Maximum share of the original characters that may still be extractable after outlining."""

MIN_REMAINING_TEXT_CHARS = 20
"""Remaining characters below this count are ignored (e.g. form field values)."""

COMPARE_SCALE = 1
"""Scale (relative to 72 dpi) at which pages are rendered for the appearance check."""

COMPARE_REDUCTION = 4
"""The renderings are reduced by this factor (to areas of about 4x4 points) before comparing."""

CHANGED_AREA_THRESHOLD = 48
"""
Grey level difference above which an area counts as changed. pdfium renders text darker than
outlines, and Ghostscript replaces fonts that are not embedded by similar fonts, which makes text
areas differ by up to about 40 grey levels without anything being lost.
"""

MAX_CHANGED_AREA = 0.04
"""
Maximum share of changed areas per page. Unchanged pages reach up to 1.5% on real documents,
pages with missing or shifted content 6% and more. Single missing words are not detected.
"""

MAX_SIZE_FACTOR = 8.0
"""Maximum size of the outlined PDF relative to the original..."""

SIZE_ALLOWANCE_PER_PAGE = 250_000
"""
...unless it stays below this size per page. Small PDFs with fonts that are not embedded grow by
a larger factor, but rasterizing (about 1.5 to 2 MB per page at 300 dpi) would cost much more.
"""

GLYPH_PREFIX = "PteGlyph"

_PATH_OPERATORS = (b" m", b" l", b" c", b" v", b" y", b" re")
# Operators that paint a path: fill, and fill and stroke (Ghostscript uses the latter for text
# drawn with render mode 2); a translated copy in a form XObject paints the same
_FILL_OPERATORS = (b"f", b"f*", b"B", b"B*")


def ghostscript_available() -> bool:
    """Return whether the Ghostscript binary is installed."""
    return shutil.which("gs") is not None


def is_encrypted(pdf_path: Path) -> bool:
    """Return whether the PDF is encrypted, including PDFs that open without a password."""
    with pikepdf.open(pdf_path) as pdf:
        return pdf.is_encrypted


def outline_text(input_path: Path, output_path: Path, page_count: int) -> None:
    """
    Convert all text of a PDF to vector outlines with Ghostscript.

    Raises:
        RuntimeError: If Ghostscript fails or times out
    """
    timeout = GS_TIMEOUT_BASE + GS_TIMEOUT_PER_PAGE * page_count
    command = ["gs", *GS_ARGS, f"-sOutputFile={output_path}", str(input_path)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Ghostscript did not finish within {timeout} seconds")
    except OSError as e:
        raise RuntimeError(f"Ghostscript could not be started: {e}")
    if result.returncode != 0 or not output_path.exists():
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError(f"Ghostscript failed: {detail[-1] if detail else f'exit code {result.returncode}'}")


@dataclass
class _Shape:
    """Subpaths of a painted path that overlap each other, typically one glyph."""

    lines: list[bytes]
    """The original path lines."""

    key: bytes
    """The path relative to its origin, followed by the paint operator."""

    origin: tuple[float, float]
    bbox: tuple[float, float, float, float]
    """Bounding box relative to the origin (including control points)."""


@dataclass
class _PathGroup:
    """A painted path in a content stream: the lines from the first moveto to the paint operator."""

    start: int
    end: int
    """Index of the line with the paint operator."""

    shapes: list[_Shape]


_Subpath = tuple[list[bytes], list[float], tuple[float, float, float, float]]
"""Lines, coordinates and bounding box of a subpath."""

MAX_SUBPATHS = 2000
"""Paths with more subpaths are not split into shapes (they are rarely text)."""


def _format(value: float) -> bytes:
    """Format a coordinate with at most two decimals."""
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return (text if text not in ("-0", "") else "0").encode()


def _parse_subpaths(lines: list[bytes]) -> Optional[list[_Subpath]]:
    """
    Split path lines into subpaths.

    Returns:
        For each subpath its lines, its coordinates (x, y pairs; for "re" x, y, width, height)
        and its bounding box, or None if a line cannot be parsed
    """
    subpaths: list[_Subpath] = []
    current_lines: list[bytes] = []
    current_values: list[float] = []
    xs: list[float] = []
    ys: list[float] = []

    def flush() -> None:
        if current_lines and xs:
            subpaths.append((list(current_lines), list(current_values), (min(xs), min(ys), max(xs), max(ys))))
        current_lines.clear()
        current_values.clear()
        xs.clear()
        ys.clear()

    for line in lines:
        if line == b"h":
            current_lines.append(line)
            continue
        parts = line.split()
        operator = parts[-1]
        try:
            values = [float(v) for v in parts[:-1]]
        except ValueError:
            return None
        if operator in (b"m", b"re"):
            flush()
        if operator == b"re":
            if len(values) != 4:
                return None
            x, y, w, h = values
            xs.extend([x, x + w])
            ys.extend([y, y + h])
        else:
            if len(values) % 2 or not values:
                return None
            xs.extend(values[0::2])
            ys.extend(values[1::2])
        current_lines.append(line)
        current_values.extend(values)
    flush()
    return subpaths


def _cluster(boxes: list[tuple[float, float, float, float]]) -> list[list[int]]:
    """Group boxes that overlap, directly or through other boxes; returns index lists in input order."""
    parent = list(range(len(boxes)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    active: list[int] = []
    for i in sorted(range(len(boxes)), key=lambda i: boxes[i][0]):
        x0, y0, _, y1 = boxes[i]
        active = [j for j in active if boxes[j][2] >= x0]
        for j in active:
            if boxes[j][1] <= y1 and y0 <= boxes[j][3]:
                parent[find(j)] = find(i)
        active.append(i)
    clusters: dict[int, list[int]] = {}
    for i in range(len(boxes)):
        clusters.setdefault(find(i), []).append(i)
    return sorted(clusters.values(), key=lambda members: members[0])


def _make_shape(subpaths: list[_Subpath], paint: bytes) -> _Shape:
    """Build a shape from subpaths, relative to its first point."""
    ox, oy = subpaths[0][1][0], subpaths[0][1][1]
    body: list[bytes] = []
    lines: list[bytes] = []
    for sub_lines, _, _ in subpaths:
        lines.extend(sub_lines)
        for line in sub_lines:
            if line == b"h":
                body.append(line)
                continue
            parts = line.split()
            operator = parts[-1]
            values = [float(v) for v in parts[:-1]]
            if operator == b"re":
                relative = [values[0] - ox, values[1] - oy, values[2], values[3]]
            else:
                relative = [v - (ox if k % 2 == 0 else oy) for k, v in enumerate(values)]
            body.append(b" ".join([*(_format(v) for v in relative), operator]))
    body.append(paint)
    x0 = min(box[0] for _, _, box in subpaths) - ox
    y0 = min(box[1] for _, _, box in subpaths) - oy
    x1 = max(box[2] for _, _, box in subpaths) - ox
    y1 = max(box[3] for _, _, box in subpaths) - oy
    return _Shape(lines=lines, key=b"\n".join(body), origin=(ox, oy), bbox=(x0, y0, x1, y1))


def _find_path_groups(lines: list[bytes]) -> list[_PathGroup]:
    """
    Find the painted paths in the lines of a content stream written by Ghostscript, and split
    each into shapes.

    Ghostscript writes the glyphs of a text run either as one path each or as one path for the
    whole run. Subpaths that do not overlap can be painted separately with the same result, since
    the fill rule only matters where subpaths overlap, so a path is split into groups of
    overlapping subpaths, which are mostly single glyphs.
    """
    groups: list[_PathGroup] = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if not (line.endswith(b" m") or line.endswith(b" re")):
            i += 1
            continue
        j = i
        while j < n and (lines[j] == b"h" or lines[j].endswith(_PATH_OPERATORS)):
            j += 1
        if j < n and lines[j] in _FILL_OPERATORS and j - i >= 2:
            subpaths = _parse_subpaths(lines[i:j])
            if subpaths:
                if len(subpaths) > MAX_SUBPATHS:
                    clusters = [list(range(len(subpaths)))]
                else:
                    clusters = _cluster([box for _, _, box in subpaths])
                shapes = [_make_shape([subpaths[k] for k in members], lines[j]) for members in clusters]
                groups.append(_PathGroup(start=i, end=j, shapes=shapes))
        i = max(j, i + 1)
    return groups


@dataclass
class _ContentHolder:
    """A page or form XObject whose content stream is compacted."""

    obj: pikepdf.Object
    is_page: bool
    lines: list[bytes]
    groups: list[_PathGroup]


def _read_lines(obj: pikepdf.Object, is_page: bool) -> list[bytes]:
    """Return the lines of the content stream of a page or form XObject."""
    if is_page:
        contents = obj.get("/Contents")
        if contents is None:
            return []
        streams = [contents] if isinstance(contents, pikepdf.Stream) else list(contents)
        data = b"\n".join(stream.read_bytes() for stream in streams)
    else:
        data = obj.read_bytes()
    return [line.strip() for line in data.split(b"\n")]


def _collect_holders(pdf: pikepdf.Pdf) -> list[_ContentHolder]:
    """
    Return the pages and the form XObjects they use (Ghostscript puts page content into forms).

    Forms without their own resources are skipped, since glyph forms could not be added to them.
    """
    holders: list[_ContentHolder] = []
    seen: set[tuple[int, int]] = set()

    def visit_forms(resources: Optional[pikepdf.Object], depth: int) -> None:
        if resources is None or depth > 3:
            return
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return
        for _, ref in xobjects.items():
            if not isinstance(ref, pikepdf.Stream) or ref.get("/Subtype") != pikepdf.Name.Form:
                continue
            if ref.objgen in seen or ref.objgen == (0, 0):
                continue
            seen.add(ref.objgen)
            form_resources = ref.get("/Resources")
            if form_resources is None:
                continue
            holders.append(_ContentHolder(ref, False, [], []))
            visit_forms(form_resources, depth + 1)

    for page in pdf.pages:
        holders.append(_ContentHolder(page.obj, True, [], []))
        visit_forms(page.obj.get("/Resources"), 0)
    return holders


def compact_glyph_paths(input_path: Path, output_path: Path) -> int:
    """
    Store shapes that occur more than once (glyph outlines) as form XObjects.

    The content streams of the pages and of the form XObjects they use are processed.

    Args:
        input_path: PDF written by outline_text()
        output_path: Where to write the compacted PDF

    Returns:
        The number of distinct shapes stored as form XObjects
    """
    with pikepdf.open(input_path) as pdf:
        holders = _collect_holders(pdf)
        counts: dict[bytes, int] = {}
        for holder in holders:
            holder.lines = _read_lines(holder.obj, holder.is_page)
            holder.groups = _find_path_groups(holder.lines)
            for group in holder.groups:
                for shape in group.shapes:
                    counts[shape.key] = counts.get(shape.key, 0) + 1

        forms: dict[bytes, tuple[str, pikepdf.Object]] = {}
        for holder in holders:
            groups = [g for g in holder.groups if any(counts[s.key] > 1 for s in g.shapes)]
            if not groups:
                continue
            lines = holder.lines
            out: list[bytes] = []
            used_names: dict[str, pikepdf.Object] = {}
            position = 0
            for group in groups:
                out.extend(lines[position:group.start])
                paint = lines[group.end]
                for shape in group.shapes:
                    if counts[shape.key] < 2:
                        out.extend(shape.lines)
                        out.append(paint)
                        continue
                    if shape.key not in forms:
                        x0, y0, x1, y1 = shape.bbox
                        # generous margin for the stroke of "B" paths
                        margin = max(2.0, x1 - x0, y1 - y0)
                        form = pikepdf.Stream(pdf, shape.key)
                        form.Type = pikepdf.Name.XObject
                        form.Subtype = pikepdf.Name.Form
                        form.BBox = [x0 - margin, y0 - margin, x1 + margin, y1 + margin]
                        forms[shape.key] = (f"{GLYPH_PREFIX}{len(forms)}", pdf.make_indirect(form))
                    name, form_ref = forms[shape.key]
                    used_names[name] = form_ref
                    ox, oy = shape.origin
                    out.append(b"q 1 0 0 1 " + _format(ox) + b" " + _format(oy) + b" cm /" + name.encode() + b" Do Q")
                position = group.end + 1
            out.extend(lines[position:])
            resources = holder.obj.get("/Resources")
            if resources is None:
                resources = holder.obj.Resources = pikepdf.Dictionary()
            xobjects = resources.get("/XObject")
            if xobjects is None:
                xobjects = resources.XObject = pikepdf.Dictionary()
            for name, form_ref in used_names.items():
                xobjects[pikepdf.Name("/" + name)] = form_ref
            data = b"\n".join(out)
            if holder.is_page:
                holder.obj.Contents = pdf.make_stream(data)
            else:
                holder.obj.write(data)
        pdf.save(output_path, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    return len(forms)


def _page_image(page: pdfium.PdfPage) -> Image.Image:
    """Render a page for the appearance check."""
    image = page.render(scale=COMPARE_SCALE, grayscale=True).to_pil().convert("L")
    size = (max(1, image.width // COMPARE_REDUCTION), max(1, image.height // COMPARE_REDUCTION))
    return image.resize(size, Image.Resampling.BOX)


def page_difference(original: pdfium.PdfPage, changed: pdfium.PdfPage) -> float:
    """Return the share of areas (0-1) whose rendering changed noticeably between two pages."""
    a, b = _page_image(original), _page_image(changed)
    if a.size != b.size:
        return 1.0
    histogram = ImageChops.difference(a, b).histogram()
    return sum(histogram[CHANGED_AREA_THRESHOLD:]) / sum(histogram)


def _text_chars(page: pdfium.PdfPage) -> int:
    """Return the number of non-whitespace characters in the text layer of a page."""
    textpage = page.get_textpage()
    try:
        return sum(1 for c in textpage.get_text_range() if not c.isspace())
    finally:
        textpage.close()


def verify_outlined(original_path: Path, outlined_path: Path) -> Optional[str]:
    """
    Check that outlining kept the pages and their appearance and removed the text.

    Returns:
        None if the result can be used, otherwise the reason why not
    """
    original = pdfium.PdfDocument(str(original_path))
    outlined = pdfium.PdfDocument(str(outlined_path))
    try:
        if len(original) != len(outlined):
            return f"the page count changed from {len(original)} to {len(outlined)}"
        original_size = original_path.stat().st_size
        outlined_size = outlined_path.stat().st_size
        if outlined_size > max(MAX_SIZE_FACTOR * original_size, SIZE_ALLOWANCE_PER_PAGE * len(original)):
            return f"converting the text to outlines made the file {outlined_size / original_size:.0f} times larger"
        original_chars = remaining_chars = 0
        for index in range(len(original)):
            a, b = original[index], outlined[index]
            try:
                for box in ("get_mediabox", "get_cropbox"):
                    box_a, box_b = getattr(a, box)(), getattr(b, box)()
                    if any(abs(x - y) > 0.5 for x, y in zip(box_a, box_b)):
                        return f"the page size of page {index + 1} changed"
                if a.get_rotation() != b.get_rotation():
                    return f"the rotation of page {index + 1} changed"
                original_chars += _text_chars(a)
                remaining_chars += _text_chars(b)
                difference = page_difference(a, b)
                if difference > MAX_CHANGED_AREA:
                    return f"page {index + 1} looks different after converting the text to outlines ({difference:.0%} of the page changed)"
            finally:
                a.close()
                b.close()
        if remaining_chars > max(MIN_REMAINING_TEXT_CHARS, MAX_REMAINING_TEXT_RATIO * original_chars):
            return f"{remaining_chars} characters could not be converted to outlines (e.g. Type 3 fonts)"
    finally:
        original.close()
        outlined.close()
    return None
