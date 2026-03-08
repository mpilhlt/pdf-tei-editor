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
                metadata
            )
            """
        )
        return True
    except sqlite3.OperationalError:
        logger.warning("FTS5 not available, falling back to plain table with LIKE search")
        conn.execute(
            "CREATE TABLE search_fts(xml_id TEXT, pdf_id TEXT, metadata TEXT)"
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
        tei_files = [f for f in doc_files if f.file_type == "tei" and f.is_gold_standard]
        if not pdf or not tei_files:
            continue
        for tei in tei_files:
            variant_part = f" [{tei.variant}]" if tei.variant else ""
            owner_part = f" ({tei.created_by})" if tei.created_by else ""
            metadata = (
                f"{_get_label(pdf)} ({doc_id}) - "
                f"review{variant_part}{owner_part}"
            )
            records.append((tei.stable_id, pdf.stable_id, metadata))

    conn.executemany("INSERT INTO search_fts VALUES (?, ?, ?)", records)
    conn.commit()

    logger.debug("Built document search index: %d entries", len(records))
    return conn, use_fts5


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


def _search_fts5(
    conn: sqlite3.Connection, q: str
) -> list[dict[str, str]]:
    """Search using FTS5 MATCH. Returns [] on malformed query."""
    terms = _parse_query(q)
    if not terms:
        return []
    fts_query = _build_fts5_query(terms)
    try:
        rows = conn.execute(
            """
            SELECT xml_id, pdf_id,
                   highlight(search_fts, 2, '<strong>', '</strong>') as match
            FROM search_fts
            WHERE search_fts MATCH ?
            ORDER BY rank
            """,
            (fts_query,),
        ).fetchall()
        return [{"xml_id": r[0], "pdf_id": r[1], "match": r[2]} for r in rows]
    except sqlite3.OperationalError as e:
        logger.debug("FTS5 query error (malformed query): %s", e)
        return []


def _search_like(
    conn: sqlite3.Connection, q: str
) -> list[dict[str, str]]:
    """LIKE-based fallback search with Python-side scoring and highlighting."""
    terms = _parse_query(q)
    if not terms:
        return []

    # Build AND-based LIKE query
    conditions = " AND ".join(["LOWER(metadata) LIKE ?" for _ in terms])
    like_args = [f"%{t.strip('\"').lower()}%" for t in terms]

    rows = conn.execute(
        f"SELECT xml_id, pdf_id, metadata FROM search_fts WHERE {conditions}",
        like_args,
    ).fetchall()

    results = []
    for xml_id, pdf_id, metadata in rows:
        match_count = sum(
            1 for t in terms if t.strip('"').lower() in metadata.lower()
        )
        results.append(
            {
                "xml_id": xml_id,
                "pdf_id": pdf_id,
                "match": _highlight_like(metadata, terms),
                "_score": match_count,
            }
        )

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
    q: str = Query(..., min_length=4),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
) -> JSONResponse:
    """Return JSON search results for the given query."""
    user = _authenticate(session_id, x_session_id, session_manager, auth_manager)
    sid = x_session_id or session_id

    lock = _get_lock(sid)
    async with lock:
        if sid not in _search_cache:
            conn, use_fts5 = _build_index(db, user)
            _search_cache[sid] = (conn, use_fts5)

    conn, use_fts5 = _search_cache[sid]
    if use_fts5:
        matches = _search_fts5(conn, q)
    else:
        matches = _search_like(conn, q)

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
