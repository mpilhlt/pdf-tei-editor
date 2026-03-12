"""
Custom routes for the Document Search plugin.

Provides:
  GET  /api/plugins/document-search/view         - Search UI HTML page
  GET  /api/plugins/document-search/results      - JSON search results
  POST /api/plugins/document-search/cache/clear  - Invalidate per-session index
"""

import asyncio
import logging
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import get_auth_manager, get_db, get_session_manager
from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.permissions.user_utils import get_user_collections
from fastapi_app.lib.plugins.plugin_tools import load_plugin_html
from fastapi_app.lib.repository.file_repository import FileRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/document-search", tags=["document-search"])

# Per-session in-memory search index: session_id -> (connection, use_fts5)
_search_cache: dict[str, tuple[sqlite3.Connection, bool]] = {}
_cache_locks: dict[str, asyncio.Lock] = {}

# Fields that can be used in the filter DSL (field:value syntax)
_FILTERABLE_FIELDS = {"is_gold_standard", "status", "variant", "created_by", "collection"}
# Values treated as boolean true for is_gold_standard
_BOOL_TRUE = {"true", "1", "yes"}

# Column positions in rows returned by SELECT * FROM search_fts
# Order must match _create_search_table and _build_index
_COL_XML_ID = 0
_COL_PDF_ID = 1
_COL_IS_GOLD = 2
_COL_STATUS = 3
_COL_VARIANT = 4
_COL_CREATED_BY = 5
_COL_COLLECTION = 6   # pipe-separated collection IDs
_COL_METADATA = 7     # FTS-indexed text; also index for highlight()

_FILTER_COL_IDX: dict[str, int] = {
    "is_gold_standard": _COL_IS_GOLD,
    "status": _COL_STATUS,
    "variant": _COL_VARIANT,
    "created_by": _COL_CREATED_BY,
    "collection": _COL_COLLECTION,
}


def _get_lock(session_id: str) -> asyncio.Lock:
    if session_id not in _cache_locks:
        _cache_locks[session_id] = asyncio.Lock()
    return _cache_locks[session_id]


def _get_label(f: FileMetadata) -> str:
    """Return display label following priority: label > doc_metadata title > doc_id."""
    if f.label and f.label.lower() not in ("untitled", "unknown title"):
        return f.label
    title = (f.doc_metadata or {}).get("title", "")
    if title and title.lower() not in ("untitled", "unknown title"):
        return title
    return f.doc_id


def _create_search_table(conn: sqlite3.Connection) -> bool:
    """
    Create the search table. Returns True if FTS5 is available, False for LIKE fallback.
    """
    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE search_fts USING fts5(
                xml_id UNINDEXED,
                pdf_id UNINDEXED,
                is_gold_standard UNINDEXED,
                status UNINDEXED,
                variant UNINDEXED,
                created_by UNINDEXED,
                collection UNINDEXED,
                metadata
            )
            """
        )
        return True
    except sqlite3.OperationalError:
        logger.warning("FTS5 not available, falling back to plain table with LIKE search")
        conn.execute(
            "CREATE TABLE search_fts("
            "xml_id TEXT, pdf_id TEXT, is_gold_standard TEXT, status TEXT,"
            " variant TEXT, created_by TEXT, collection TEXT, metadata TEXT)"
        )
        conn.execute("CREATE INDEX idx_metadata ON search_fts(metadata)")
        return False


def _build_index(db: Any, user: Any) -> tuple[sqlite3.Connection, bool]:
    """Build the in-memory search index for the given user's accessible documents."""
    settings = get_settings()
    file_repo = FileRepository(db)

    accessible_collections = get_user_collections(user, settings.db_dir)
    all_files = file_repo.list_files(include_deleted=False)

    if accessible_collections is not None:
        files = [
            f
            for f in all_files
            if any(c in accessible_collections for c in (f.doc_collections or []))
        ]
    else:
        files = all_files

    # Group by doc_id
    by_doc_id: dict[str, list[FileMetadata]] = {}
    for f in files:
        by_doc_id.setdefault(f.doc_id, []).append(f)

    conn = sqlite3.connect(":memory:")
    use_fts5 = _create_search_table(conn)

    records = []
    for doc_id, doc_files in by_doc_id.items():
        pdf = next((f for f in doc_files if f.file_type == "pdf"), None)
        tei_files = [f for f in doc_files if f.file_type == "tei"]
        if not pdf or not tei_files:
            continue

        # One representative per (doc_id, variant): gold standard or highest version.
        by_variant: dict[str | None, list[FileMetadata]] = {}
        for tei in tei_files:
            by_variant.setdefault(tei.variant, []).append(tei)

        collection_str = "|".join(pdf.doc_collections or [])

        for _variant, variant_teis in by_variant.items():
            gold = next((t for t in variant_teis if t.is_gold_standard), None)
            best = gold if gold else max(variant_teis, key=lambda t: t.version or 0)

            metadata = f"{_get_label(pdf)} ({doc_id})"
            is_gold = "1" if best.is_gold_standard else "0"
            records.append((
                best.stable_id,
                pdf.stable_id,
                is_gold,
                best.status,
                best.variant,
                best.created_by,
                collection_str,
                metadata,
            ))

    conn.executemany("INSERT INTO search_fts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", records)
    conn.commit()

    logger.debug("Built document search index: %d entries", len(records))
    return conn, use_fts5


def _parse_dsl(q: str) -> tuple[list[tuple[str, bool, list[str]]], str]:
    """
    Parse DSL filter tokens from a query string.

    Syntax: ``field:value``, ``field:not:value``, ``field:v1|v2``, ``field:not:v1|v2``
    Supported fields: is_gold_standard, status, variant, created_by, collection
    Boolean fields (is_gold_standard): true/1/yes -> '1', anything else -> '0'

    Returns:
        filters: list of (field, negated, values) tuples
        remaining: query string with filter tokens removed
    """
    _filter_re = re.compile(r'^(\w+):(not:)?(.+)$')
    filters: list[tuple[str, bool, list[str]]] = []
    remaining: list[str] = []

    for token in q.split():
        m = _filter_re.match(token)
        if m and m.group(1) in _FILTERABLE_FIELDS:
            field = m.group(1)
            negated = bool(m.group(2))
            raw_values = m.group(3).split("|")
            if field == "is_gold_standard":
                values = ["1" if v.lower() in _BOOL_TRUE else "0" for v in raw_values]
            else:
                values = raw_values
            filters.append((field, negated, values))
        else:
            remaining.append(token)

    return filters, " ".join(remaining)


def _apply_filters_python(
    rows: list[tuple],
    filters: list[tuple[str, bool, list[str]]],
) -> list[tuple]:
    """Post-filter rows in Python by DSL filter conditions.

    ``collection`` is special: the column stores pipe-separated IDs, so we check
    set intersection rather than equality.
    """
    for field, negated, values in filters:
        col_idx = _FILTER_COL_IDX[field]
        if field == "collection":
            value_set = set(values)
            if negated:
                rows = [
                    r for r in rows
                    if not (set(filter(None, (r[col_idx] or "").split("|"))) & value_set)
                ]
            else:
                rows = [
                    r for r in rows
                    if set(filter(None, (r[col_idx] or "").split("|"))) & value_set
                ]
        else:
            if negated:
                rows = [r for r in rows if r[col_idx] not in values]
            else:
                rows = [r for r in rows if r[col_idx] in values]
    return rows


def _row_to_result(r: tuple, match_text: str) -> dict:
    """Convert a DB row to the JSON result dict returned to the frontend."""
    collections = [c for c in (r[_COL_COLLECTION] or "").split("|") if c]
    return {
        "xml_id": r[_COL_XML_ID],
        "pdf_id": r[_COL_PDF_ID],
        "match": match_text,
        "is_gold": r[_COL_IS_GOLD] == "1",
        "status": r[_COL_STATUS],
        "variant": r[_COL_VARIANT],
        "created_by": r[_COL_CREATED_BY],
        "collections": collections,
    }


def _parse_query(q: str) -> list[str]:
    """Split query on whitespace, preserving quoted phrases."""
    return re.findall(r'"[^"]*"|\S+', q)


def _build_fts5_query(terms: list[str]) -> str:
    """Build FTS5 MATCH expression from terms.

    Unquoted terms are split on non-word characters so that e.g. "10.1163"
    becomes the sub-tokens ["10", "1163"]. All sub-tokens except the last are
    matched exactly; the last gets a prefix wildcard (*).
    """
    fts_parts: list[str] = []
    for term in terms:
        if term.startswith('"'):
            fts_parts.append(term)
        else:
            sub = [t for t in re.split(r'\W+', term) if t]
            if not sub:
                continue
            fts_parts.extend(sub[:-1])
            fts_parts.append(sub[-1] + "*")
    return " AND ".join(fts_parts)


def _highlight_like(text: str, terms: list[str]) -> str:
    """Wrap matched terms in <strong> tags for LIKE fallback results."""
    result = text
    for term in terms:
        clean = term.strip('"')
        if not clean:
            continue
        result = re.sub(
            f"({re.escape(clean)})",
            r"<strong>\1</strong>",
            result,
            flags=re.IGNORECASE,
        )
    return result


_SELECT_ALL = (
    "SELECT xml_id, pdf_id, is_gold_standard, status, variant, created_by, collection, metadata"
    " FROM search_fts"
)


def _search_fts5(
    conn: sqlite3.Connection,
    q: str,
    filters: list[tuple[str, bool, list[str]]],
) -> list[dict]:
    """Search using FTS5 MATCH + optional DSL filters. Returns [] on malformed query.

    Filters are applied in Python after the SQL query to avoid FTS5 limitations
    when combining MATCH with WHERE conditions on UNINDEXED columns.
    Filter-only queries fetch all rows and apply all filters in Python.
    """
    terms = _parse_query(q) if q.strip() else []

    try:
        if terms:
            fts_query = _build_fts5_query(terms)
            rows = conn.execute(
                f"SELECT xml_id, pdf_id, is_gold_standard, status, variant, created_by, collection,"
                f"       highlight(search_fts, {_COL_METADATA}, '<strong>', '</strong>') as match"
                f" FROM search_fts WHERE search_fts MATCH ? ORDER BY rank",
                [fts_query],
            ).fetchall()
            if filters:
                rows = _apply_filters_python(rows, filters)
            return [_row_to_result(r, r[_COL_METADATA]) for r in rows]

        elif filters:
            rows = conn.execute(_SELECT_ALL).fetchall()
            rows = _apply_filters_python(rows, filters)
            return [_row_to_result(r, r[_COL_METADATA]) for r in rows]

        else:
            return []

    except sqlite3.OperationalError as e:
        logger.debug("FTS5 query error (malformed query): %s", e)
        return []


def _search_like(
    conn: sqlite3.Connection,
    q: str,
    filters: list[tuple[str, bool, list[str]]],
) -> list[dict]:
    """LIKE-based fallback search with Python-side scoring, highlighting, and filtering."""
    terms = _parse_query(q) if q.strip() else []

    if not terms and not filters:
        return []

    if terms:
        conditions = ["LOWER(metadata) LIKE ?" for _ in terms]
        like_args: list[Any] = [f"%{t.strip('\"').lower()}%" for t in terms]
        where = " AND ".join(conditions)
        rows = conn.execute(f"{_SELECT_ALL} WHERE {where}", like_args).fetchall()
    else:
        rows = conn.execute(_SELECT_ALL).fetchall()

    if filters:
        rows = _apply_filters_python(rows, filters)

    results = []
    for r in rows:
        metadata = r[_COL_METADATA]
        match_count = sum(1 for t in terms if t.strip('"').lower() in metadata.lower())
        result = _row_to_result(r, _highlight_like(metadata, terms) if terms else metadata)
        result["_score"] = match_count
        results.append(result)

    results.sort(key=lambda r: r["_score"], reverse=True)
    for r in results:
        del r["_score"]
    return results


def _authenticate(
    session_id: str | None,
    x_session_id: str | None,
    session_manager: Any,
    auth_manager: Any,
) -> Any:
    """Shared authentication helper. Returns the authenticated user."""
    settings = get_settings()
    sid = x_session_id or session_id
    if not sid:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not session_manager.is_session_valid(sid, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = auth_manager.get_user_by_session_id(sid, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


@router.get("/view", response_class=HTMLResponse)
async def view(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> HTMLResponse:
    """Serve the standalone search UI HTML page."""
    _authenticate(session_id, x_session_id, session_manager, auth_manager)
    html = load_plugin_html(__file__, "view.html")
    return HTMLResponse(content=html)


@router.get("/results")
async def results(
    q: str = Query(..., min_length=1),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
) -> JSONResponse:
    """Return JSON search results for the given query."""
    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    sid = x_session_id or session_id

    filters, text_query = _parse_dsl(q)

    # Require either meaningful text terms or at least one DSL filter
    if not filters and len(text_query.strip()) < 4:
        return JSONResponse(content=[])

    lock = _get_lock(sid)
    async with lock:
        if sid not in _search_cache:
            conn, use_fts5 = _build_index(db, user)
            _search_cache[sid] = (conn, use_fts5)

    conn, use_fts5 = _search_cache[sid]
    if use_fts5:
        matches = _search_fts5(conn, text_query, filters)
    else:
        matches = _search_like(conn, text_query, filters)

    return JSONResponse(content=matches)


@router.post("/cache/clear", status_code=204)
async def clear_cache(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
) -> Response:
    """Invalidate the search index for this session (called on window close)."""
    _authenticate(session_id, x_session_id, session_manager, auth_manager)
    sid = x_session_id or session_id

    if sid in _search_cache:
        conn, _ = _search_cache.pop(sid)
        conn.close()
    _cache_locks.pop(sid, None)

    return Response(status_code=204)
