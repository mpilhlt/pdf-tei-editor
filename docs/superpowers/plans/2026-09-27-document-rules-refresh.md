# Document Rules Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement "Refreshing document rules" from `docs/superpowers/specs/2026-09-27-document-rules-registry-design.md` — a generalized, core "Refresh document rules" reviewer action that regenerates both a document's `editorialDecl` (interpretation-ref) entries and its schema processing instruction from its extractor's *current* configuration, dispatched via a new `DocumentRulesProvider` registry keyed by the document's own `appInfo/application[@type="extractor"]/@ident`. This subsumes and replaces GROBID's plugin-scoped "Refresh Annotation Rules" action and the `tei-wizard` "Add RNG Schema Definition" enhancement.

**Architecture:** Two new core modules under `fastapi_app/lib/doc_rules/`: `rules_providers.py` (the provider registry + extractor-provenance parsing) and `rules_refresh.py` (the moved-and-generalized orchestration, ported from GROBID's `annotation_rules_refresh.py`, now also regenerating the schema PI). Two new JSON endpoints, `POST /api/v1/document-rules/refresh/{preview,execute}`, added to the existing `fastapi_app/routers/document_rules.py` router (reviewer/admin-gated), returning structured data rather than HTML — consistent with every other endpoint already on that router, and with the fact that the confirmation UI itself belongs to the separate, not-yet-written frontend plan. GROBID and llamore-extractor each register a small adapter class implementing `DocumentRulesProvider`, delegating to their existing config functions. GROBID's own `annotation_rules_refresh.py`, its two `/api/plugins/grobid/refresh-annotation-rules/*` routes, its `refresh_annotation_rules` plugin endpoint, and the `tei-wizard` `add-rng-schema-definition.js` enhancement are deleted outright (spec: "Migration" — no migration needed, this correctly relocates rather than duplicates the feature).

**Tech Stack:** FastAPI, Pydantic, lxml, existing `UrlCache`/`resolve_forge_permalink`/`extract_schema_locations`/`create_schema_processing_instruction` utilities.

---

## Important context for every task below

- Run Python tests with `uv run python tests/unit-test-runner.py <path> -v` (never bare `pytest`).
- Run GROBID-specific and llamore-specific Python tests the same way, e.g. `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_rules_provider_registration.py -v`.
- Run JS tests with `node tests/backend-test-runner.js --test-dir <dir>` (plugin-scoped JS) or `npm run test:unit:js` (frontend/unit JS).
- **A critical, non-obvious correctness fact for Task 2, discovered empirically before writing this plan** (do not "simplify away" the ordering described there): `_replace_editorial_decl()` and `_add_revision_change()` both round-trip the document through `etree.fromstring(bytes)` → `etree.tostring(root, ...)`, serializing **only the returned root `Element`**. Verified directly:

  ```python
  from lxml import etree
  xml = b'<?xml version="1.0"?>\n<?xml-model href="foo.rng" ...?>\n<TEI xmlns="..."><teiHeader/></TEI>'
  root = etree.fromstring(xml)
  etree.tostring(root, encoding="unicode")  # the <?xml-model?> PI is GONE - silently dropped
  ```

  Any processing instruction preceding the root element (i.e. the schema `<?xml-model?>` PI) is **silently dropped** by this round-trip. This means whenever *either* half changes (or even when only one half changes, since `_add_revision_change()` runs on every write), the schema PI must be explicitly restored as the **last**, purely textual step of `perform_refresh()` — using whichever schema URL should currently be in effect, not only when the schema URL itself changed — or an editorialDecl-only refresh would silently delete an untouched schema PI. Task 2's code and tests below already account for this; preserve that design.

---

## Task 1: Provider registry and extractor-provenance parsing

**Files:**

- Create: `fastapi_app/lib/doc_rules/rules_providers.py`
- Test: `tests/unit/fastapi/test_doc_rules_rules_providers.py`

- [ ] **Step 1: Write the failing tests**

```python
"""
Unit tests for the document rules registry's extractor-provider registry.

@testCovers fastapi_app/lib/doc_rules/rules_providers.py
"""

import unittest

from fastapi_app.lib.doc_rules.rules_providers import (
    extract_extractor_provenance,
    get_document_rules_provider_for_document,
    register_document_rules_provider,
    unregister_document_rules_provider,
)

TEI_WITH_PROVENANCE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="GROBID" type="extractor">
      <label type="variant-id">grobid.training.segmentation</label>
    </application>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""

TEI_WITHOUT_VARIANT_ID = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="GROBID" type="extractor"/>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""

TEI_WITHOUT_APP_INFO = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc/></teiHeader>
</TEI>"""


class TestExtractExtractorProvenance(unittest.TestCase):
    def test_reads_ident_and_variant_id(self):
        self.assertEqual(
            extract_extractor_provenance(TEI_WITH_PROVENANCE),
            ("GROBID", "grobid.training.segmentation"),
        )

    def test_returns_none_when_variant_id_missing(self):
        self.assertIsNone(extract_extractor_provenance(TEI_WITHOUT_VARIANT_ID))

    def test_returns_none_when_no_application_element(self):
        self.assertIsNone(extract_extractor_provenance(TEI_WITHOUT_APP_INFO))

    def test_returns_none_for_malformed_xml(self):
        self.assertIsNone(extract_extractor_provenance("<TEI><unclosed></TEI>"))


class TestProviderRegistry(unittest.TestCase):
    def tearDown(self):
        unregister_document_rules_provider("GROBID")
        unregister_document_rules_provider("TEST-IDENT")

    def test_unregistered_ident_returns_none(self):
        self.assertIsNone(get_document_rules_provider_for_document(TEI_WITH_PROVENANCE))

    def test_registered_provider_is_found_by_ident(self):
        provider = object()
        register_document_rules_provider("GROBID", "grobid", provider)

        result = get_document_rules_provider_for_document(TEI_WITH_PROVENANCE)

        self.assertIsNotNone(result)
        variant_id, found_provider = result
        self.assertEqual(variant_id, "grobid.training.segmentation")
        self.assertIs(found_provider, provider)

    def test_unregister_then_lookup_returns_none(self):
        register_document_rules_provider("TEST-IDENT", "test-plugin", object())
        unregister_document_rules_provider("TEST-IDENT")

        tei = TEI_WITH_PROVENANCE.replace("GROBID", "TEST-IDENT")
        self.assertIsNone(get_document_rules_provider_for_document(tei))

    def test_no_provenance_returns_none_even_if_a_provider_is_registered(self):
        register_document_rules_provider("GROBID", "grobid", object())
        self.assertIsNone(get_document_rules_provider_for_document(TEI_WITHOUT_APP_INFO))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_providers.py -v`
Expected: FAIL (`ModuleNotFoundError: fastapi_app.lib.doc_rules.rules_providers`)

- [ ] **Step 3: Implement the module**

```python
"""
Registry mapping a document's extractor identity to the plugin that can
regenerate its document rules (interpretation-ref editorialDecl entries and
schema PI). See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Refreshing document rules").

Provenance is read from encodingDesc/appInfo/application[@type="extractor"]
- the oldest, most stable per-document record this app writes (see
docs/development/tei-header-integrations.md), present even on documents
extracted before editorialDecl or this feature existed. Extractor plugins
register one DocumentRulesProvider each, keyed by their own @ident, at
plugin initialize() time.
"""

from typing import Optional, Protocol

from lxml import etree

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef

TEI_NS = "http://www.tei-c.org/ns/1.0"


class DocumentRulesProvider(Protocol):
    """What an extractor plugin implements to support "Refresh document rules"."""

    def build_editorial_decl_entries(self, variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
        """Current interpretation-ref entries for variant_id. Return [] if this extractor has none."""
        ...

    def get_schema_url(self, variant_id: str) -> Optional[str]:
        """Current schema URL for variant_id, or None if this extractor has no schema mapping."""
        ...


_registry: dict[str, tuple[str, DocumentRulesProvider]] = {}


def register_document_rules_provider(extractor_ident: str, plugin_id: str, provider: DocumentRulesProvider) -> None:
    """Register (or replace) the provider for one extractor @ident."""
    _registry[extractor_ident] = (plugin_id, provider)


def unregister_document_rules_provider(extractor_ident: str) -> None:
    """Remove a previously registered provider, if any. No-op if none is registered."""
    _registry.pop(extractor_ident, None)


def extract_extractor_provenance(tei_content: str) -> Optional[tuple[str, str]]:
    """
    Read (extractor @ident, variant-id label) from a TEI document's
    encodingDesc/appInfo/application[@type="extractor"].

    Returns None if the document isn't parseable (even leniently), has no
    such application element, or either value is missing/empty - all
    treated as "nothing to dispatch a refresh to" by callers, not raised.
    """
    parser = etree.XMLParser(recover=True)
    try:
        root = etree.fromstring(tei_content.encode("utf-8"), parser)
    except etree.XMLSyntaxError:
        return None

    app = root.find(".//encodingDesc/appInfo/application[@type='extractor']")
    if app is None:
        app = root.find(
            f".//{{{TEI_NS}}}encodingDesc/{{{TEI_NS}}}appInfo/{{{TEI_NS}}}application[@type='extractor']"
        )
    if app is None:
        return None

    ident = app.get("ident")

    variant_el = app.find("label[@type='variant-id']")
    if variant_el is None:
        variant_el = app.find(f"{{{TEI_NS}}}label[@type='variant-id']")
    variant_id = variant_el.text if variant_el is not None else None

    if not ident or not variant_id:
        return None
    return ident, variant_id


def get_document_rules_provider_for_document(xml_string: str) -> Optional[tuple[str, DocumentRulesProvider]]:
    """
    Resolve the DocumentRulesProvider that can refresh this document's rules.

    Reads the document's extractor @ident and variant-id and looks up a
    provider registered for that ident. Returns (variant_id, provider) -
    variant_id is what a caller needs to actually invoke the provider's
    methods. Returns None both when the document has no readable extractor
    provenance and when no provider is registered for its ident - to a
    caller these are the same "nothing to refresh" outcome (see
    rules_refresh.py's "No rule-refresh provider ..." message).
    """
    provenance = extract_extractor_provenance(xml_string)
    if provenance is None:
        return None
    ident, variant_id = provenance
    entry = _registry.get(ident)
    if entry is None:
        return None
    _plugin_id, provider = entry
    return variant_id, provider
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_providers.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/doc_rules/rules_providers.py tests/unit/fastapi/test_doc_rules_rules_providers.py
git commit -m "feat(doc-rules): add the DocumentRulesProvider registry"
```

---

## Task 2: Core refresh orchestration (`rules_refresh.py`)

Ports and generalizes `fastapi_app/plugins/grobid/annotation_rules_refresh.py`. Read that file (already in your context if you're the controller; otherwise open it) for the parts that are carried over unchanged: `_replace_editorial_decl()` and `_add_revision_change()` (byte-for-byte logic, just relocated). This task adds: `RefreshTarget` no longer requires a recognizable extractor variant to resolve (that check moves to provider lookup, so legacy documents still resolve); a `DocumentRulesProvider` lookup replaces the direct `build_editorial_decl_entries` import; a new `_replace_schema_pi()` regenerates the schema PI; and a shared `RefreshOutcome` result type covers both a read-only preview and the real execute.

**Files:**

- Create: `fastapi_app/lib/doc_rules/rules_refresh.py`
- Test: `tests/unit/fastapi/test_doc_rules_rules_refresh.py`

- [ ] **Step 1: Write the failing tests**

```python
"""
Unit tests for fastapi_app/lib/doc_rules/rules_refresh.py.

@testCovers fastapi_app/lib/doc_rules/rules_refresh.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.doc_rules.rules_providers import (
    register_document_rules_provider,
    unregister_document_rules_provider,
)
from fastapi_app.lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    RefreshTarget,
    perform_refresh,
    preview_refresh,
    resolve_refresh_target,
)
from fastapi_app.lib.models.models import FileMetadata

TEI_WITH_PI_AND_DECL = """<?xml version="1.0"?>
<?xml-model href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""

TEI_LEGACY_NO_EDITORIAL_DECL_NO_PI = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""

TEI_NO_PROVENANCE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc/></teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""

# Mismatched <p>/</div> tags: lenient-parseable (extract_extractor_provenance()
# uses etree.XMLParser(recover=True), so provider lookup succeeds) but not
# strictly well-formed, so the plain etree.fromstring() inside
# _replace_editorial_decl()/_add_revision_change() raises XMLSyntaxError.
MALFORMED_TEI = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</div></body></text>
</TEI>
"""


def make_tei_file(content: str, stable_id="tei-1", file_id="hash-old"):
    content_bytes = content.encode("utf-8")
    meta = FileMetadata(
        id=file_id,
        stable_id=stable_id,
        filename="doc.tei.xml",
        doc_id="doc-1",
        file_type="tei",
        file_size=len(content_bytes),
    )
    return meta, content_bytes


class FakeProvider:
    def __init__(self, entries=None, schema_url=None):
        self._entries = entries if entries is not None else []
        self._schema_url = schema_url

    def build_editorial_decl_entries(self, variant_id, cache):
        return self._entries

    def get_schema_url(self, variant_id):
        return self._schema_url


class TestResolveRefreshTarget(unittest.TestCase):
    def setUp(self):
        self.file_repo = mock.MagicMock()
        self.file_storage = mock.MagicMock()
        self.user = {"username": "reviewer1"}

    def test_raises_when_no_file(self):
        self.file_repo.get_file_by_stable_id.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "missing", self.user)

    @mock.patch("fastapi_app.lib.doc_rules.rules_refresh.check_file_access", return_value=False)
    def test_raises_when_permission_denied(self, _mock_access):
        meta, content = make_tei_file(TEI_WITH_PI_AND_DECL)
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.file_storage.read_file.assert_not_called()

    @mock.patch("fastapi_app.lib.doc_rules.rules_refresh.check_file_access", return_value=True)
    def test_raises_when_content_missing(self, _mock_access):
        meta, _content = make_tei_file(TEI_WITH_PI_AND_DECL)
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)

    @mock.patch("fastapi_app.lib.doc_rules.rules_refresh.check_file_access", return_value=True)
    def test_resolves_even_without_recognizable_extractor_variant(self, _mock_access):
        # Resolving a target no longer requires a readable extractor
        # variant - see RefreshTarget's docstring. Whether anything can
        # actually be refreshed is a separate, later check (provider lookup).
        meta, content = make_tei_file(TEI_NO_PROVENANCE)
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content

        target = resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.assertEqual(target.file_meta, meta)


class TestPreviewAndPerformRefresh(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        unregister_document_rules_provider("GROBID")

    def _target(self, content):
        meta, content_bytes = make_tei_file(content)
        return RefreshTarget(file_meta=meta, tei_content=content_bytes.decode("utf-8"))

    def test_no_provider_registered_reports_unavailable_without_erroring(self):
        target = self._target(TEI_WITH_PI_AND_DECL)
        outcome = preview_refresh(target, cache=mock.MagicMock())
        self.assertFalse(outcome.available)
        self.assertIn("No rule-refresh provider", outcome.message)

    async def test_perform_refresh_no_provider_registered_does_not_write(self):
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertFalse(outcome.available)
        file_storage.save_file.assert_not_called()

    def test_preview_reports_unchanged_when_nothing_differs(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)

        outcome = preview_refresh(target, cache=mock.MagicMock())

        self.assertTrue(outcome.available)
        self.assertFalse(outcome.changed)
        self.assertIn("already up to date", outcome.message)

    async def test_replaces_editorial_decl_and_schema_pi_and_adds_change(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        self.assertEqual(outcome.entry_count, 1)

        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn("newsha", saved_content)
        self.assertNotIn("oldsha", saved_content)
        self.assertIn('href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng"', saved_content)
        self.assertNotIn("grobid.training.segmentation.rng", saved_content)
        self.assertIn("Updated document rules", saved_content)
        file_repo.update_file.assert_called_once()

    async def test_regenerates_only_the_half_that_changed(self):
        # Schema URL differs, entries do not - editorialDecl content itself
        # (the "oldsha" ref) must be untouched.
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn("oldsha", saved_content)
        self.assertIn('href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng"', saved_content)

    async def test_schema_pi_survives_an_editorial_decl_only_refresh(self):
        # Regression test for the round-trip PI-loss issue documented at the
        # top of this plan: entries differ, schema URL does NOT - the
        # existing schema PI must still be present afterward, not silently
        # dropped by the editorialDecl/revisionDesc rewrite.
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn('href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng"', saved_content)

    async def test_generates_editorial_decl_and_schema_pi_on_legacy_document(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_LEGACY_NO_EDITORIAL_DECL_NO_PI)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn("editorialDecl", saved_content)
        self.assertIn('<?xml-model href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng"', saved_content)

    async def test_raises_runtime_error_on_malformed_xml(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
        ))
        target = self._target(MALFORMED_TEI)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        with self.assertRaises(RuntimeError):
            await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_refresh.py -v`
Expected: FAIL (`ModuleNotFoundError: fastapi_app.lib.doc_rules.rules_refresh`)

- [ ] **Step 3: Implement the module**

```python
"""
Core logic for the "Refresh document rules" reviewer action: regenerates a
document's interpretation-ref editorialDecl entries and its schema
processing instruction from its extractor's current DocumentRulesProvider,
re-resolving permalinks/schema URLs to what's current now. Generalizes what
was GROBID-plugin-specific annotation_rules_refresh.py (see
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
Part G) to any registered extractor, and adds schema-PI regeneration
(replacing the removed tei_wizard "Add RNG Schema Definition" enhancement).
See docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Refreshing document rules").
"""

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from lxml import etree

from fastapi_app.lib.core.schema_validator import extract_schema_locations
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document
from fastapi_app.lib.models.models import FileMetadata, FileUpdate
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef, extract_annotation_rule_refs
from fastapi_app.lib.utils.tei_utils import create_schema_processing_instruction

TEI_NS = "http://www.tei-c.org/ns/1.0"


class RefreshPreconditionError(Exception):
    """Raised when the target document cannot be resolved for a refresh."""


@dataclass
class RefreshTarget:
    """
    The document a rules-refresh would act on.

    Resolving one only needs file/permission/content - not an existing
    editorialDecl, and not even a readable extractor variant, so a legacy
    or malformed-provenance document still resolves here (see the design
    spec's "Refreshing document rules" precondition note). Whether anything
    can actually be refreshed is determined separately, by looking up a
    DocumentRulesProvider (see _plan_refresh()).
    """

    file_meta: FileMetadata
    tei_content: str


@dataclass
class RefreshOutcome:
    """
    Shared result shape for both preview_refresh() (dry run) and
    perform_refresh() (real write).

    `available=False` means no rules-refresh provider is registered for
    this document's extractor - not an error, just nothing to refresh.
    `changed` is always False from preview_refresh() (nothing is ever
    written there); from perform_refresh() it reflects whether anything
    was actually rewritten.
    """

    available: bool
    changed: bool
    entry_count: int
    variant_id: Optional[str]
    message: str


def resolve_refresh_target(
    file_repo: FileRepository,
    file_storage: FileStorage,
    stable_id: str,
    user: Optional[dict],
) -> RefreshTarget:
    """
    Resolve and validate the document a rules refresh would target.

    Read-only. Raises RefreshPreconditionError with a user-facing message if
    the document cannot be resolved, including when *user* lacks edit access
    to it.
    """
    file_meta = file_repo.get_file_by_stable_id(stable_id)
    if not file_meta or file_meta.file_type != "tei":
        raise RefreshPreconditionError("No TEI document open.")

    if not check_file_access(file_meta, user, "edit"):
        raise RefreshPreconditionError("You don't have permission to edit this document.")

    content_bytes = file_storage.read_file(file_meta.id, "tei")
    if not content_bytes:
        raise RefreshPreconditionError("File content not found.")

    return RefreshTarget(file_meta=file_meta, tei_content=content_bytes.decode("utf-8"))


def _current_schema_location(tei_content: str) -> Optional[str]:
    """The document's current RelaxNG schema location, if any (v1 scope: RelaxNG only)."""
    for location in extract_schema_locations(tei_content):
        if location["type"] == "relaxng":
            return location["schemaLocation"]
    return None


_XML_MODEL_PI_RE = re.compile(r"<\?xml-model\b[^>]*\?>\n?")
_XML_DECL_RE = re.compile(r"^<\?xml\b[^>]*\?>\n?")


def _replace_schema_pi(tei_content: str, schema_url: str) -> str:
    """
    Replace (or insert) the document's RelaxNG <?xml-model?> schema PI.

    Text-level remove-then-insert, mirroring what the now-deleted
    tei_wizard/enhancements/add-rng-schema-definition.js did in the browser
    DOM (see the design spec's Migration section) - lxml's
    etree.fromstring()/tostring() round-trip on just the root element does
    not preserve a document-level PI that precedes the root element (see
    this plan's header note), so this operates on the raw text instead,
    consistent with how extract_schema_locations() already reads this PI.
    Inserted immediately after the XML declaration if present (documents
    this app saves never have one - see serialize_tei_with_formatted_header()
    - so in practice this always inserts at the very start of the string).
    """
    without_existing = _XML_MODEL_PI_RE.sub("", tei_content)
    new_pi = create_schema_processing_instruction(schema_url) + "\n"
    decl_match = _XML_DECL_RE.match(without_existing)
    if decl_match:
        insert_at = decl_match.end()
        return without_existing[:insert_at] + new_pi + without_existing[insert_at:]
    return new_pi + without_existing


def _replace_editorial_decl(tei_content: str, entries: list[AnnotationRuleRef]) -> str:
    """
    Replace (or insert) the document's editorialDecl with fresh entries.

    Inserted as the first child of encodingDesc, before appInfo/schemaRef,
    matching the order create_encoding_desc_with_extractor() uses. Returns
    the content unchanged if entries is empty and there was nothing to
    replace either. Also returns the content unchanged (defensive, expected
    unreachable in practice since every TEI document created by this app
    has an encodingDesc) if the document has no encodingDesc at all.
    """
    root = etree.fromstring(tei_content.encode("utf-8"))
    ns = {"tei": TEI_NS}

    encoding_desc = root.find(".//tei:encodingDesc", ns)
    if encoding_desc is None:
        return tei_content

    existing = encoding_desc.find("tei:editorialDecl", ns)
    if existing is not None:
        encoding_desc.remove(existing)

    if not entries:
        return etree.tostring(root, encoding="unicode")

    editorial_decl = etree.Element(f"{{{TEI_NS}}}editorialDecl")
    for entry in entries:
        interpretation = etree.SubElement(editorial_decl, f"{{{TEI_NS}}}interpretation", type=entry["category"])
        p = etree.SubElement(interpretation, f"{{{TEI_NS}}}p")
        for ref_entry in entry["refs"]:
            ref = etree.SubElement(p, f"{{{TEI_NS}}}ref", target=ref_entry["target"], subtype=ref_entry["subtype"])
            content_type = ref_entry["content_type"]
            if content_type is not None:
                ref.set("type", content_type)
    encoding_desc.insert(0, editorial_decl)

    return etree.tostring(root, encoding="unicode")


def _add_revision_change(tei_content: str, who: Optional[str]) -> str:
    """Append a <change> entry to revisionDesc noting the rules refresh."""
    root = etree.fromstring(tei_content.encode("utf-8"))
    ns = {"tei": TEI_NS}

    revision_desc = root.find(".//tei:revisionDesc", ns)
    if revision_desc is None:
        tei_header = root.find(".//tei:teiHeader", ns)
        if tei_header is None:
            raise RuntimeError("Document has no teiHeader; cannot record the refresh as a revision.")
        revision_desc = etree.SubElement(tei_header, f"{{{TEI_NS}}}revisionDesc")

    change = etree.SubElement(revision_desc, f"{{{TEI_NS}}}change")
    change.set("when", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
    if who:
        change.set("who", f"#{who}")
    desc = etree.SubElement(change, f"{{{TEI_NS}}}desc")
    desc.text = "Updated document rules"

    return etree.tostring(root, encoding="unicode")


@dataclass
class _RefreshPlan:
    """Internal: what a refresh would do, computed once and shared by preview_refresh() and perform_refresh()."""

    available: bool
    variant_id: Optional[str]
    new_entries: list[AnnotationRuleRef]
    editorial_decl_changed: bool
    new_schema_url: Optional[str]
    existing_schema_url: Optional[str]
    schema_changed: bool


def _plan_refresh(tei_content: str, cache: UrlCache) -> _RefreshPlan:
    lookup = get_document_rules_provider_for_document(tei_content)
    if lookup is None:
        return _RefreshPlan(
            available=False, variant_id=None, new_entries=[], editorial_decl_changed=False,
            new_schema_url=None, existing_schema_url=None, schema_changed=False,
        )
    variant_id, provider = lookup

    new_entries = provider.build_editorial_decl_entries(variant_id, cache)
    existing_entries = extract_annotation_rule_refs(tei_content)
    # NOTE: extract_annotation_rule_refs() can return entries carrying an "n"
    # key (interpretation/@n); no provider currently sets it when building
    # fresh entries. This comparison only stays symmetric because nothing
    # currently writes @n. If a future provider starts producing @n, update
    # both sides together, or every document with @n will look "changed"
    # and lose its label on refresh.
    editorial_decl_changed = new_entries != existing_entries

    new_schema_url = provider.get_schema_url(variant_id)
    existing_schema_url = _current_schema_location(tei_content)
    schema_changed = new_schema_url is not None and new_schema_url != existing_schema_url

    return _RefreshPlan(
        available=True, variant_id=variant_id, new_entries=new_entries,
        editorial_decl_changed=editorial_decl_changed,
        new_schema_url=new_schema_url, existing_schema_url=existing_schema_url,
        schema_changed=schema_changed,
    )


def _describe_plan(plan: _RefreshPlan, verb: str) -> str:
    """Build RefreshOutcome.message. verb is 'Would update' (preview) or 'Updated' (execute)."""
    if not plan.available:
        return "No rule-refresh provider for this document's extractor."
    if not plan.editorial_decl_changed and not plan.schema_changed:
        return "Document rules are already up to date."
    parts = []
    if plan.editorial_decl_changed:
        plural = "y" if len(plan.new_entries) == 1 else "ies"
        parts.append(f"the annotation rules reference ({len(plan.new_entries)} entr{plural})")
    if plan.schema_changed:
        parts.append("the schema reference")
    return f"{verb} " + " and ".join(parts) + "."


def preview_refresh(target: RefreshTarget, cache: UrlCache) -> RefreshOutcome:
    """Read-only: reports what perform_refresh() would change, without writing anything."""
    plan = _plan_refresh(target.tei_content, cache)
    return RefreshOutcome(
        available=plan.available,
        changed=plan.editorial_decl_changed or plan.schema_changed,
        entry_count=len(plan.new_entries),
        variant_id=plan.variant_id,
        message=_describe_plan(plan, "Would update"),
    )


async def perform_refresh(
    target: RefreshTarget,
    file_repo: FileRepository,
    file_storage: FileStorage,
    who: Optional[str],
    cache: UrlCache,
) -> RefreshOutcome:
    """
    Regenerate the document's editorialDecl and/or schema PI from its
    extractor's current DocumentRulesProvider and save it, if anything
    changed. Works on a legacy document with no editorialDecl or schema PI
    at all - see RefreshTarget's docstring and the design spec's
    "Refreshing document rules" precondition note.

    Raises RuntimeError if the document's XML cannot be re-parsed for the
    rewrite (its extractor provenance was readable via a lenient parse, but
    the document is not strictly well-formed) or has no teiHeader to record
    the change in - callers catch this the same way
    reload_feature_file.py's routes catch RuntimeError from
    perform_reload().
    """
    plan = _plan_refresh(target.tei_content, cache)
    if not plan.available:
        return RefreshOutcome(
            available=False, changed=False, entry_count=0, variant_id=None,
            message=_describe_plan(plan, "Updated"),
        )

    if not plan.editorial_decl_changed and not plan.schema_changed:
        return RefreshOutcome(
            available=True, changed=False, entry_count=len(plan.new_entries),
            variant_id=plan.variant_id, message=_describe_plan(plan, "Updated"),
        )

    try:
        new_content = target.tei_content
        if plan.editorial_decl_changed:
            new_content = _replace_editorial_decl(new_content, plan.new_entries)
        new_content = _add_revision_change(new_content, who)

        # Both round-trips above silently drop any PI preceding the root
        # element (confirmed empirically - see this plan's header note), so
        # restoring the schema PI must happen last, unconditionally whenever
        # anything was rewritten, using whichever URL should currently be in
        # effect - not only when schema_changed - or an editorialDecl-only
        # refresh would silently delete an untouched schema PI.
        final_schema_url = plan.new_schema_url if plan.new_schema_url is not None else plan.existing_schema_url
        if final_schema_url is not None:
            new_content = _replace_schema_pi(new_content, final_schema_url)
    except etree.XMLSyntaxError as e:
        raise RuntimeError(f"Could not parse document XML for refresh: {e}") from e

    new_bytes = new_content.encode("utf-8")
    saved_hash, _ = file_storage.save_file(new_bytes, target.file_meta.file_type, increment_ref=False)
    if saved_hash != target.file_meta.id:
        file_repo.update_file(target.file_meta.id, FileUpdate(id=saved_hash, file_size=len(new_bytes)))

    return RefreshOutcome(
        available=True, changed=True, entry_count=len(plan.new_entries),
        variant_id=plan.variant_id, message=_describe_plan(plan, "Updated"),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_rules_refresh.py -v`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/doc_rules/rules_refresh.py tests/unit/fastapi/test_doc_rules_rules_refresh.py
git commit -m "feat(doc-rules): add generalized core refresh orchestration with schema-PI regeneration"
```

---

## Task 3: REST API — `POST /refresh/preview` and `POST /refresh/execute`

**Files:**

- Modify: `fastapi_app/lib/models/models_document_rules.py`
- Modify: `fastapi_app/routers/document_rules.py`
- Test: `tests/unit/fastapi/test_document_rules_router.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/fastapi/test_document_rules_router.py` (after the existing test classes; keep existing imports, add the ones shown):

```python
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi_app.lib.core.dependencies import get_file_storage
from fastapi_app.lib.doc_rules.rules_refresh import RefreshPreconditionError


class TestRefreshEndpoints(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.file_storage = MagicMock()
        self.app.dependency_overrides[get_file_storage] = lambda: self.file_storage

    def _set_user_roles(self, roles):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": roles}

    def test_preview_requires_reviewer_or_admin_role(self):
        self._set_user_roles(["user"])
        response = self.client.post("/document-rules/refresh/preview", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 403)

    def test_execute_requires_reviewer_or_admin_role(self):
        self._set_user_roles(["user"])
        response = self.client.post("/document-rules/refresh/execute", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 403)

    def test_preview_reports_precondition_error_as_bad_request(self):
        self._set_user_roles(["reviewer"])
        with patch(
            "fastapi_app.routers.document_rules.resolve_refresh_target",
            side_effect=RefreshPreconditionError("No TEI document open."),
        ):
            response = self.client.post("/document-rules/refresh/preview", json={"xml": "missing"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("No TEI document open", response.json()["detail"])

    def test_preview_reports_unavailable_when_no_provider(self):
        self._set_user_roles(["reviewer"])
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch("fastapi_app.routers.document_rules.preview_refresh") as mock_preview:
            mock_resolve.return_value = MagicMock()
            mock_preview.return_value = MagicMock(
                available=False, changed=False, entry_count=0, variant_id=None,
                message="No rule-refresh provider for this document's extractor.",
            )
            response = self.client.post("/document-rules/refresh/preview", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["available"])

    def test_execute_calls_perform_refresh_and_returns_outcome(self):
        self._set_user_roles(["admin"])
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch(
                 "fastapi_app.routers.document_rules.perform_refresh",
                 new=AsyncMock(return_value=MagicMock(
                     available=True, changed=True, entry_count=2,
                     variant_id="grobid.training.segmentation", message="Updated the annotation rules reference.",
                 )),
             ):
            mock_resolve.return_value = MagicMock()
            response = self.client.post("/document-rules/refresh/execute", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["entry_count"], 2)

    def test_execute_reports_runtime_error_as_unprocessable(self):
        self._set_user_roles(["reviewer"])
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch(
                 "fastapi_app.routers.document_rules.perform_refresh",
                 new=AsyncMock(side_effect=RuntimeError("Could not parse document XML for refresh: boom")),
             ):
            mock_resolve.return_value = MagicMock()
            response = self.client.post("/document-rules/refresh/execute", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 422)
        self.assertIn("Could not parse document XML for refresh", response.json()["detail"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_document_rules_router.py -v`
Expected: FAIL (404s for the two new routes, `ImportError` for `get_file_storage`/`RefreshPreconditionError` if not yet present)

- [ ] **Step 3: Add the request/response models**

Append to `fastapi_app/lib/models/models_document_rules.py`:

```python
class RefreshRequest(BaseModel):
    """Request to preview or execute a "Refresh document rules" action. `xml` is the target document's stable_id."""
    xml: str


class RefreshOutcomeResponse(BaseModel):
    """
    Response to both /refresh/preview and /refresh/execute.

    `available=False` means no rules-refresh provider is registered for
    this document's extractor - not an error, just nothing to refresh.
    `changed` is always False from /preview (nothing is ever written
    there); from /execute it reflects whether anything was actually
    rewritten.
    """
    available: bool
    changed: bool
    entry_count: int
    variant_id: Optional[str] = None
    message: str
```

- [ ] **Step 4: Add the router endpoints**

In `fastapi_app/routers/document_rules.py`, extend the imports:

```python
from ..config import get_settings
from ..lib.core.database import DatabaseManager
from ..lib.core.dependencies import get_db, get_document_rules_store, get_file_storage, require_authenticated_user
from ..lib.core.url_cache import UrlCache
from ..lib.doc_rules.kinds import get_resource_kind, list_resources
from ..lib.doc_rules.resource_key import infer_format, normalize_resource_key
from ..lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    perform_refresh,
    preview_refresh,
    resolve_refresh_target,
)
from ..lib.doc_rules.storage import DocumentRulesStore
from ..lib.permissions.acl_utils import user_has_role
from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.models.models_document_rules import (
    CreateOverrideRequest,
    ListResourcesRequest,
    ListResourcesResponse,
    OkResponse,
    OverrideModel,
    QueryResourceRequest,
    QueryResourceResponse,
    RefreshOutcomeResponse,
    RefreshRequest,
    ResetSelectionRequest,
    ResourceDescriptorModel,
    SetSelectionRequest,
    UpdateOverrideRequest,
)
```

(`get_settings`, `DatabaseManager`, `get_file_storage`, `UrlCache`, `RefreshPreconditionError`/`perform_refresh`/`preview_refresh`/`resolve_refresh_target`, `user_has_role`, `FileRepository`, `FileStorage`, `RefreshOutcomeResponse`, `RefreshRequest` are new; the rest already exist in the file.)

Append at the end of the file:

```python
def require_reviewer_or_admin(user: dict = Depends(require_authenticated_user)) -> dict:
    """
    Dependency: authenticated user with reviewer or admin role.

    Only the two refresh endpoints below need this - the rest of this
    router is intentionally open to any authenticated user (see
    validation.py's own comment on why schema overrides aren't
    reviewer-gated: they only ever affect the calling user's own
    validation/extraction, unlike a refresh, which rewrites the shared
    document).
    """
    if not user_has_role(user, ["reviewer", "admin"]):
        raise HTTPException(status_code=403, detail="Reviewer role required")
    return user


def _outcome_response(outcome) -> RefreshOutcomeResponse:
    return RefreshOutcomeResponse(
        available=outcome.available,
        changed=outcome.changed,
        entry_count=outcome.entry_count,
        variant_id=outcome.variant_id,
        message=outcome.message,
    )


@router.post("/refresh/preview", response_model=RefreshOutcomeResponse)
async def refresh_preview(
    request: RefreshRequest,
    user: dict = Depends(require_reviewer_or_admin),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RefreshOutcomeResponse:
    """Read-only preview of what "Refresh document rules" would change for this document."""
    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, request.xml, user)
    except RefreshPreconditionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    outcome = preview_refresh(target, cache)
    return _outcome_response(outcome)


@router.post("/refresh/execute", response_model=RefreshOutcomeResponse)
async def refresh_execute(
    request: RefreshRequest,
    user: dict = Depends(require_reviewer_or_admin),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RefreshOutcomeResponse:
    """Perform the document rules refresh: regenerate and save if anything changed."""
    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, request.xml, user)
    except RefreshPreconditionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    try:
        outcome = await perform_refresh(target, file_repo, file_storage, user.get("username"), cache)
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return _outcome_response(outcome)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_document_rules_router.py -v`
Expected: PASS (all tests in the file, existing + new)

- [ ] **Step 6: Regenerate the API client**

```bash
npm run generate-client
```

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/lib/models/models_document_rules.py fastapi_app/routers/document_rules.py \
        tests/unit/fastapi/test_document_rules_router.py app/src/modules/api-client-v1.js
git commit -m "feat(doc-rules): add POST /document-rules/refresh/{preview,execute}"
```

---

## Task 4: GROBID registers as a `DocumentRulesProvider`; delete GROBID's own refresh module/routes

**Files:**

- Modify: `fastapi_app/plugins/grobid/annotation_rules.py`
- Modify: `fastapi_app/plugins/grobid/plugin.py`
- Modify: `fastapi_app/plugins/grobid/routes.py`
- Modify: `fastapi_app/plugins/grobid/tests/test_plugin_endpoints.py`
- Delete: `fastapi_app/plugins/grobid/annotation_rules_refresh.py`
- Delete: `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py`
- Delete: `fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py`
- Test: `fastapi_app/plugins/grobid/tests/test_rules_provider_registration.py` (new)

- [ ] **Step 1: Write the failing test**

Create `fastapi_app/plugins/grobid/tests/test_rules_provider_registration.py`:

```python
"""
Unit tests for GROBID's DocumentRulesProvider registration.

@testCovers fastapi_app/plugins/grobid/plugin.py
@testCovers fastapi_app/plugins/grobid/annotation_rules.py
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document
from fastapi_app.plugins.grobid.annotation_rules import GrobidRulesProvider

TEI_GROBID = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="GROBID" type="extractor">
      <label type="variant-id">grobid.training.segmentation</label>
    </application>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""


class TestGrobidRulesProvider(unittest.TestCase):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules.build_editorial_decl_entries")
    def test_build_editorial_decl_entries_delegates(self, mock_build):
        mock_build.return_value = [{"category": "primary", "refs": []}]
        provider = GrobidRulesProvider()
        cache = mock.MagicMock()

        result = provider.build_editorial_decl_entries("grobid.training.segmentation", cache)

        self.assertEqual(result, [{"category": "primary", "refs": []}])
        mock_build.assert_called_once_with("grobid.training.segmentation", cache)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules.get_schema_url")
    def test_get_schema_url_delegates(self, mock_get_url):
        mock_get_url.return_value = "https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng"
        provider = GrobidRulesProvider()

        result = provider.get_schema_url("grobid.training.segmentation")

        self.assertEqual(result, "https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng")
        mock_get_url.assert_called_once_with("grobid.training.segmentation")


class TestGrobidPluginRegistersProvider(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin
        self.plugin = GrobidPlugin.__new__(GrobidPlugin)  # skip __init__ (config bootstrap)
        context = mock.Mock()
        context.get_dependency.return_value = None  # no tei-wizard dependency in this test
        asyncio.run(self.plugin.initialize(context))

    def tearDown(self):
        asyncio.run(self.plugin.cleanup())

    def test_registers_grobid_as_a_provider(self):
        result = get_document_rules_provider_for_document(TEI_GROBID)
        self.assertIsNotNone(result)
        variant_id, provider = result
        self.assertEqual(variant_id, "grobid.training.segmentation")
        self.assertIsInstance(provider, GrobidRulesProvider)

    def test_cleanup_unregisters_the_provider(self):
        asyncio.run(self.plugin.cleanup())
        self.assertIsNone(get_document_rules_provider_for_document(TEI_GROBID))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_rules_provider_registration.py -v`
Expected: FAIL (`ImportError: cannot import name 'GrobidRulesProvider'`)

- [ ] **Step 3: Add `GrobidRulesProvider`**

In `fastapi_app/plugins/grobid/annotation_rules.py`, change the imports at the top to add `Optional` and `get_schema_url`:

```python
from typing import Optional

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRef,
    AnnotationRuleRefTarget,
    is_line_range_fragment,
    resolve_forge_permalink,
    translate_anchor_to_line_range,
)
from fastapi_app.plugins.grobid.config import AnnotationGuide, get_annotation_guides, get_schema_url
```

Append at the end of the file:

```python
class GrobidRulesProvider:
    """
    Adapts this plugin's existing annotation-guide/schema config to the
    DocumentRulesProvider protocol so "Refresh document rules" (a core
    action, see fastapi_app/lib/doc_rules/rules_refresh.py) can dispatch to
    it. Registered once, in GrobidPlugin.initialize().
    """

    def build_editorial_decl_entries(self, variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
        return build_editorial_decl_entries(variant_id, cache)

    def get_schema_url(self, variant_id: str) -> Optional[str]:
        return get_schema_url(variant_id)
```

- [ ] **Step 4: Wire registration into `GrobidPlugin`, remove the plugin-scoped refresh action**

In `fastapi_app/plugins/grobid/plugin.py`:

Add to the imports:

```python
from fastapi_app.lib.doc_rules.rules_providers import register_document_rules_provider, unregister_document_rules_provider
from fastapi_app.plugins.grobid.annotation_rules import GrobidRulesProvider
```

Remove this endpoint metadata entry (the third item in `metadata["endpoints"]`, the `"refresh_annotation_rules"` dict):

```python
                {
                    "name": "refresh_annotation_rules",
                    "label": "Refresh Annotation Rules",
                    "description": (
                        "Re-derive this document's annotation rules reference from the "
                        "current configuration, re-resolving it to the guidelines' latest "
                        "commit. Use this when the guidelines document has been updated "
                        "and you want this document to point at the new version."
                    ),
                    "category": "grobid",
                    "icon": "arrow-repeat",
                    "state_params": ["xml"],
                    "required_roles": ["reviewer"],
                },
```

Remove `"refresh_annotation_rules": self.refresh_annotation_rules,` from `get_endpoints()`.

In `initialize()`, add (right after `registry.register(GrobidTrainingExtractor)`):

```python
        register_document_rules_provider("GROBID", "grobid", GrobidRulesProvider())
```

In `cleanup()`, add (right after `registry.unregister("grobid")`):

```python
        unregister_document_rules_provider("GROBID")
```

Remove the entire `refresh_annotation_rules` method (the whole `async def refresh_annotation_rules(self, context, params)` block, including its docstring).

- [ ] **Step 5: Remove GROBID's own refresh routes**

In `fastapi_app/plugins/grobid/routes.py`, remove the two route handlers `refresh_annotation_rules_preview` and `refresh_annotation_rules_execute` (the whole `@router.get("/refresh-annotation-rules/preview", ...)` and `@router.get("/refresh-annotation-rules/execute", ...)` blocks, including their docstrings and bodies, from `@router.get("/refresh-annotation-rules/preview"...)` down to just before `@router.post("/cancel/{progress_id}")`).

- [ ] **Step 6: Delete the superseded module and its tests**

```bash
git rm fastapi_app/plugins/grobid/annotation_rules_refresh.py
git rm fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py
git rm fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh_routes.py
```

- [ ] **Step 7: Update `test_plugin_endpoints.py`**

In `fastapi_app/plugins/grobid/tests/test_plugin_endpoints.py`, remove the `test_refresh_annotation_rules_endpoint_is_registered` test method and the entire `RefreshAnnotationRulesTriggerTestCase` class (everything from `class RefreshAnnotationRulesTriggerTestCase` to just before `if __name__ == "__main__":`).

- [ ] **Step 8: Run tests to verify everything passes**

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_rules_provider_registration.py -v
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_plugin_endpoints.py -v
uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v
```

Expected: all PASS; no references to `annotation_rules_refresh` remain anywhere (`grep -rn "annotation_rules_refresh\|refresh_annotation_rules\|refresh-annotation-rules" fastapi_app/` should return nothing).

- [ ] **Step 9: Commit**

```bash
git add fastapi_app/plugins/grobid/
git commit -m "refactor(doc-rules): move GROBID's refresh action onto the core DocumentRulesProvider registry"
```

---

## Task 5: llamore registers as a provider; delete the `tei-wizard` schema enhancement; full-suite verification

**Files:**

- Modify: `fastapi_app/plugins/llamore_extractor/plugin.py`
- Test: `fastapi_app/plugins/llamore_extractor/tests/test_rules_provider_registration.py` (new)
- Delete: `fastapi_app/plugins/tei_wizard/enhancements/add-rng-schema-definition.js`
- Modify: `fastapi_app/plugins/tei_wizard/README.md`
- Modify: `tests/api/v1/tei_wizard_enhancements.test.js`
- Modify: `docs/development/tei-header-integrations.md`

- [ ] **Step 1: Write the failing test**

Create `fastapi_app/plugins/llamore_extractor/tests/test_rules_provider_registration.py`:

```python
"""
Unit tests for LLamore's DocumentRulesProvider registration.

@testCovers fastapi_app/plugins/llamore_extractor/plugin.py
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document

TEI_LLAMORE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="llamore" type="extractor">
      <label type="variant-id">llamore-default</label>
    </application>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""


class TestLlamoreRulesProvider(unittest.TestCase):
    def test_build_editorial_decl_entries_returns_empty(self):
        from fastapi_app.plugins.llamore_extractor.plugin import LlamoreRulesProvider

        provider = LlamoreRulesProvider()
        self.assertEqual(provider.build_editorial_decl_entries("llamore-default", mock.MagicMock()), [])

    @mock.patch("fastapi_app.plugins.llamore_extractor.plugin.get_schema_url")
    def test_get_schema_url_delegates(self, mock_get_url):
        from fastapi_app.plugins.llamore_extractor.plugin import LlamoreRulesProvider

        mock_get_url.return_value = "https://mpilhlt.github.io/llamore/schema/llamore-default.rng"
        provider = LlamoreRulesProvider()

        result = provider.get_schema_url("llamore-default")

        self.assertEqual(result, "https://mpilhlt.github.io/llamore/schema/llamore-default.rng")
        mock_get_url.assert_called_once_with("llamore-default")


class TestLLamorePluginRegistersProvider(unittest.TestCase):
    def setUp(self):
        from fastapi_app.plugins.llamore_extractor.plugin import LLamorePlugin, LlamoreRulesProvider
        self.LlamoreRulesProvider = LlamoreRulesProvider
        self.plugin = LLamorePlugin.__new__(LLamorePlugin)  # skip __init__ (config bootstrap)
        asyncio.run(self.plugin.initialize(mock.Mock()))

    def tearDown(self):
        asyncio.run(self.plugin.cleanup())

    def test_registers_llamore_as_a_provider(self):
        result = get_document_rules_provider_for_document(TEI_LLAMORE)
        self.assertIsNotNone(result)
        variant_id, provider = result
        self.assertEqual(variant_id, "llamore-default")
        self.assertIsInstance(provider, self.LlamoreRulesProvider)

    def test_cleanup_unregisters_the_provider(self):
        asyncio.run(self.plugin.cleanup())
        self.assertIsNone(get_document_rules_provider_for_document(TEI_LLAMORE))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/llamore_extractor/tests/test_rules_provider_registration.py -v`
Expected: FAIL (`ImportError: cannot import name 'LlamoreRulesProvider'`)

- [ ] **Step 3: Add `LlamoreRulesProvider` and wire it into `LLamorePlugin`**

Rewrite `fastapi_app/plugins/llamore_extractor/plugin.py`:

```python
"""
LLamore extractor plugin.

Registers the LLamoreExtractor with the extraction registry.
"""

import logging
from typing import Any, Callable, Optional

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.rules_providers import register_document_rules_provider, unregister_document_rules_provider
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef
from .config import get_schema_url, init_plugin_config
from .extractor import LLamoreExtractor

logger = logging.getLogger(__name__)


class LlamoreRulesProvider:
    """
    Adapts this plugin's schema config to the DocumentRulesProvider
    protocol so "Refresh document rules" (a core action, see
    fastapi_app/lib/doc_rules/rules_refresh.py) can dispatch to it.
    Registered once, in LLamorePlugin.initialize().

    build_editorial_decl_entries() returns [] - this extractor's only
    editorialDecl entry today ("additional-instructions", see
    extractor.py's _resolve_additional_instructions()) is generated per-
    extraction from the user's own selected override, not from a
    re-derivable config the way GROBID's annotation guides are, so there is
    nothing here for a refresh to regenerate. ANNOTATION_GUIDES in
    config.py feeds a separate, older mechanism (the Annotation Guide
    drawer, via get_info()'s annotationGuides field) unrelated to
    editorialDecl.
    """

    def build_editorial_decl_entries(self, variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
        return []

    def get_schema_url(self, variant_id: str) -> Optional[str]:
        return get_schema_url(variant_id)


class LLamorePlugin(Plugin):
    """Plugin that provides LLamore-based extraction."""

    def __init__(self) -> None:
        init_plugin_config()

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "llamore",
            "name": "LLamore Extractor",
            "description": "Extract references using LLamore with Gemini AI",
            "category": "extractor",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": []  # No menu items - accessed via extraction API
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {}  # Extractor accessed via /api/v1/extract endpoint

    @classmethod
    def is_available(cls) -> bool:
        """Check if LLamore extractor is available."""
        return LLamoreExtractor.is_available()

    async def initialize(self, context: PluginContext) -> None:
        """Register the LLamore extractor and its DocumentRulesProvider."""
        registry = ExtractorRegistry.get_instance()
        registry.register(LLamoreExtractor)
        register_document_rules_provider("llamore", "llamore", LlamoreRulesProvider())
        logger.info("LLamore extractor plugin initialized")

    async def cleanup(self) -> None:
        """Unregister the LLamore extractor and its DocumentRulesProvider."""
        registry = ExtractorRegistry.get_instance()
        registry.unregister("llamore-gemini")
        unregister_document_rules_provider("llamore")
        logger.info("LLamore extractor plugin cleaned up")
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/llamore_extractor/tests/test_rules_provider_registration.py -v
uv run python tests/unit-test-runner.py fastapi_app/plugins/llamore_extractor/tests/ -v
```

Expected: all PASS.

- [ ] **Step 5: Delete the obsolete `tei-wizard` enhancement**

```bash
git rm fastapi_app/plugins/tei_wizard/enhancements/add-rng-schema-definition.js
```

- [ ] **Step 6: Update `tei-wizard`'s README**

In `fastapi_app/plugins/tei_wizard/README.md`, remove this section (between "Pretty Print XML" and "Fix Common Extraction Issues"):

```markdown
### Add RNG Schema Definition (`add-rng-schema-definition.js`)

Replaces any existing schema declarations with an `<?xml-model ?>` processing instruction pointing to the appropriate RNG schema. Reads the schema URL from the document's `teiHeader` (`ref` element with a `.rng` target), falling back to the `schema.base-url` config value combined with the active variant.

```

- [ ] **Step 7: Update the JS enhancement-registry test**

In `tests/api/v1/tei_wizard_enhancements.test.js`, remove these two lines from the `'includes default enhancements'` test:

```javascript
    assert.ok(
      body.includes('Add RNG Schema Definition'),
      'Should include Add RNG Schema Definition enhancement'
    );
```

- [ ] **Step 8: Update `tei-header-integrations.md`**

In `docs/development/tei-header-integrations.md`, the "Other readers" sentence in the `encodingDesc/appInfo/application` section currently reads:

```markdown
Other readers: `parse_encoding_labels()` in `fastapi_app/plugins/grobid/sync.py` (used by the annotation-rules-refresh precondition check and the training-feature-tokens route to locate cached GROBID artifacts by variant/revision/flavor); `extract_variant_id()` in `tei_utils.py` (used by `local_sync` and `files_save.py` to populate the DB `variant` column on every save).
```

Replace it with:

```markdown
Other readers: `parse_encoding_labels()` in `fastapi_app/plugins/grobid/sync.py` (used by the training-feature-tokens route to locate cached GROBID artifacts by variant/revision/flavor); `extract_extractor_provenance()` in `fastapi_app/lib/doc_rules/rules_providers.py` (used by the "Refresh document rules" action to dispatch to the right extractor's `DocumentRulesProvider`, generically across extractors - see [2026-09-27-document-rules-registry-design.md](../superpowers/specs/2026-09-27-document-rules-registry-design.md)); `extract_variant_id()` in `tei_utils.py` (used by `local_sync` and `files_save.py` to populate the DB `variant` column on every save).
```

- [ ] **Step 9: Run the JS enhancement-registry test**

```bash
node tests/backend-test-runner.js --test-dir tests/api/v1 --grep tei_wizard_enhancements
```

Expected: PASS. (This test requires a running dev server per its `BASE_URL` default; if none is running, confirm instead via a direct diff review that the removed assertion lines match no remaining "Add RNG Schema Definition" string anywhere: `grep -rn "Add RNG Schema Definition" fastapi_app/ tests/` should return nothing.)

- [ ] **Step 10: Commit**

```bash
git add fastapi_app/plugins/llamore_extractor/ fastapi_app/plugins/tei_wizard/ \
        tests/api/v1/tei_wizard_enhancements.test.js docs/development/tei-header-integrations.md
git commit -m "refactor(doc-rules): register llamore as a rules provider; delete the obsolete RNG-schema-PI enhancement"
```

- [ ] **Step 11: Run the full test suite**

```bash
npm run test:unit
npm run test:e2e
```

Expected: green, aside from the one pre-existing, unrelated failure already tracked from prior plans (`tests/unit/fastapi/test_plugin_tools_sandbox_client.py::TestGenerateSandboxClientScript::test_uses_cached_script_when_source_missing`) and the one pre-existing API test skip. If any other failure appears, fix it before proceeding (do not defer to a later plan).

- [ ] **Step 12: Final verification - no dangling references**

```bash
grep -rn "annotation_rules_refresh\|refresh_annotation_rules\|refresh-annotation-rules\|add-rng-schema-definition\|Add RNG Schema Definition" \
  fastapi_app/ app/ tests/ docs/ --include="*.py" --include="*.js" --include="*.md" 2>/dev/null
```

Expected: no output (aside from this plan file itself and the untouched design spec, which describes the change rather than the old state).

---

## Post-plan: request a final whole-plan code review

Per `superpowers:requesting-code-review`, after all 5 tasks are committed, dispatch one more code-reviewer subagent against the full diff (`git rev-parse <plan-start-sha>` to `HEAD`) checking specifically for:

- The schema-PI-survives-a-round-trip fix (Task 2) is intact and covered by its regression test.
- No remaining code path imports from the deleted `fastapi_app/plugins/grobid/annotation_rules_refresh.py`.
- `RefreshTarget`'s relaxed precondition (no variant-id required to resolve) doesn't silently swallow a genuinely malformed document elsewhere in the call chain.
- The new `/api/v1/document-rules/refresh/{preview,execute}` endpoints are reviewer/admin-gated in both the route dependency and by an actual `TestClient` 403 test (not just by inspection).

Fix any Critical/Important findings directly, then report completion to the user with the same summary pattern used for Plans 1-3 (what was built, key review-driven catches, full-suite results), and ask whether to continue to Plan 5 (the frontend "Edit prompts/schemas" + "Refresh document rules" menu UI) or pause.
