# TEI Header Editor Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit `fileDesc` (title, publication info, source description) in a schema-driven dialog from the XML editor toolbar, instead of hand-editing raw XML.

**Architecture:** A new backend endpoint merges the open document's own resolved RelaxNG schema with the bundled core TEI schema (`schema/rng/tei-bib.rng`) to produce descriptions + cardinality for `titleStmt`/`publicationStmt`/`sourceDesc`. A new frontend plugin renders that structure as a recursive form in an `sl-dialog`, reads current values from the live editor DOM, and writes changes back via direct DOM mutation + the existing `updateEditorFromNode()`/`saveIfDirty()` path — no new backend write endpoint.

**Tech Stack:** FastAPI + Pydantic (backend), vanilla JS class-based plugin + Shoelace + CodeMirman 6 (frontend), Python `xml.etree.ElementTree` (schema parsing).

**Spec:** [docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md](../specs/2026-10-07-teiheader-editor-plugin-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `grobid-footnote-flavour/schema/shared/tei-header.rng` (sibling repo, absolute path `/Users/cboulanger/Code/grobid-footnote-flavour/schema/shared/tei-header.rng`) | Gains `<a:documentation>` for the 8 defines that `tei_bare.rng` documents |
| `fastapi_app/lib/utils/relaxng_to_codemirror.py` | Modify: add `_extract_child_cardinality()`, extend `TagDefinition`/`extract_tag_definitions()` |
| `fastapi_app/lib/models/models_validation.py` | Modify: add `TeiHeaderStructureRequest`/`TeiHeaderStructureResponse`/`ChildCardinalityModel`/`TeiHeaderTagDefinitionModel` |
| `fastapi_app/routers/validation.py` | Modify: extract shared schema-resolution helper; add `POST /validate/teiheader-structure` |
| `tests/unit/fastapi/test_relaxng_to_codemirror.py` | Modify: tests for `_extract_child_cardinality()` |
| `tests/unit/fastapi/test_validation_router.py` | Create (if no such file exists yet — checked in Task 4) or modify: tests for the new endpoint |
| `app/src/modules/api-client-v1.js` | Modify: add `TeiHeaderStructureRequest`/`Response` typedefs + `validateTeiheaderStructure()` method |
| `app/src/modules/tei-header-form.js` | Create: pure functions — build the nested field tree from a structure response, read current values from a DOM tree, compute the list of DOM mutations for a save |
| `tests/unit/js/tei-header-form.test.js` | Create: unit tests for the pure functions above |
| `app/src/templates/tei-header-editor-dialog.html` | Create: the `sl-dialog` markup (static chrome only; sections are built at runtime) |
| `app/src/templates/tei-header-editor-dialog.types.js` | Create: `@typedef` for the template's named parts |
| `app/src/plugins/tei-header-editor.js` | Create: `TeiHeaderEditorPlugin` — toolbar button, dialog wiring, role gating |
| `app/src/plugins.js` | Modify: import + register `TeiHeaderEditorPlugin` |
| `app/src/ui.js` | Modify: import the new template's typedef, add to the relevant parent typedef |
| `tests/e2e/tests/tei-header-editor.spec.js` | Create: end-to-end happy path + role-gating test |

---

### Task 1: Annotate `grobid-footnote-flavour/schema/shared/tei-header.rng`

**Files:**
- Modify: `/Users/cboulanger/Code/grobid-footnote-flavour/schema/shared/tei-header.rng`
- Create (scratch, not committed): a one-off Python script to do the extraction (run once, then discard)

This repo has no test suite wired to this plan's runner, so verification is a manual parse check, not TDD.

- [ ] **Step 1: Fetch the reference schema and extract the 8 matching docs**

```bash
curl -sL -o /tmp/tei_bare.rng https://tei-c.org/release/xml/tei/custom/schema/relaxng/tei_bare.rng
```

Then, for each of `teiHeader`, `fileDesc`, `titleStmt`, `publicationStmt`, `sourceDesc`, `title`, `author`, `label`, locate `<define name="X"><element name="X"><a:documentation>...</a:documentation>` in `/tmp/tei_bare.rng` and copy the documentation text verbatim (it's plain text, no nested markup for these 8 — verified during spec research). Keep a scratch mapping, e.g.:

```text
teiHeader: (TEI header) supplies descriptive and declarative metadata associated with a digital resource or set of resources. [2.1.1. The TEI Header and Its Components 16.1. Varieties of Composite Text]
fileDesc: (file description) contains a full bibliographic description of an electronic file. [2.2. The File Description 2.1.1. The TEI Header and Its Components]
titleStmt: (title statement) groups information about the title of a work and those responsible for its content. [2.2.1. The Title Statement 2.2. The File Description]
publicationStmt: (publication statement) groups information concerning the publication or distribution of an electronic or other text. [2.2.4. Publication, Distribution, Licensing, etc. 2.2. The File Description]
sourceDesc: (source description) describes the source(s) from which an electronic text was derived or generated, typically a bibliographic description in the case of a digitized text, or a phrase such as born digital for a text which has no previous existence. [2.2.7. The Source Description]
```

(`title`, `author`, `label` are not yet in `tei-header.rng` as standalone defines in the current file content — check `grep -n "define name=\"title\"\|define name=\"author\"\|define name=\"label\""` against the file; if they're not there as separate top-level defines, they are only referenced via `<ref name="title"/>` etc. resolved from `shared/bibl-struct.rng`/`shared/common-elements.rng` — skip annotating those two since this task's scope is `shared/tei-header.rng` only, per the design spec's "Deferred" section.)

- [ ] **Step 2: Add the `xmlns:a` namespace declaration to the grammar root**

In `/Users/cboulanger/Code/grobid-footnote-flavour/schema/shared/tei-header.rng`, the `<grammar>` open tag currently reads:

```xml
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:xml="http://www.w3.org/XML/1998/namespace"
  ns="http://www.tei-c.org/ns/1.0">
```

Add the annotations namespace:

```xml
<grammar xmlns="http://relaxng.org/ns/structure/1.0"
  xmlns:xml="http://www.w3.org/XML/1998/namespace"
  xmlns:a="http://relaxng.org/ns/compatibility/annotations/1.0"
  ns="http://www.tei-c.org/ns/1.0">
```

- [ ] **Step 3: Insert `<a:documentation>` as the first child of each matching `<element>`**

For `teiHeader` (currently):

```xml
  <define name="teiHeader">
    <element name="teiHeader">
      <zeroOrMore>
```

becomes:

```xml
  <define name="teiHeader">
    <element name="teiHeader">
      <a:documentation>(TEI header) supplies descriptive and declarative metadata associated with a digital resource or set of resources. [2.1.1. The TEI Header and Its Components 16.1. Varieties of Composite Text]</a:documentation>
      <zeroOrMore>
```

Repeat the same pattern (documentation as first child of `<element name="X">`, before whatever structural content already follows) for `fileDesc`, `titleStmt`, `publicationStmt`, `sourceDesc`, using the text collected in Step 1.

- [ ] **Step 4: Verify the file still parses and the new docs are extractable**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
uv run python -c "
from fastapi_app.lib.utils.relaxng_to_codemirror import RelaxNGParser
p = RelaxNGParser()
p.parse_file('/Users/cboulanger/Code/grobid-footnote-flavour/schema/shared/tei-header.rng')
defs = p.extract_tag_definitions('teiHeader')
for name in ['teiHeader', 'fileDesc', 'titleStmt', 'publicationStmt', 'sourceDesc']:
    assert defs[name]['description'], f'{name} missing description'
    print(name, '->', defs[name]['description'][:60])
print('OK')
"
```

Expected: prints each name with its description prefix, ends with `OK`. No exception.

- [ ] **Step 5: Commit (in the `grobid-footnote-flavour` repo)**

```bash
cd /Users/cboulanger/Code/grobid-footnote-flavour
git add schema/shared/tei-header.rng
git commit -m "$(cat <<'EOF'
Add TEI documentation annotations to shared teiHeader schema

Copies <a:documentation> from the official tei_bare.rng for the 8
defines it covers (teiHeader, fileDesc, titleStmt, publicationStmt,
sourceDesc), so the pdf-tei-editor teiHeader editor plugin can surface
real descriptions directly from this schema instead of only its core
TEI fallback.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Backend — child-element cardinality extraction

**Files:**
- Modify: `fastapi_app/lib/utils/relaxng_to_codemirror.py`
- Test: `tests/unit/fastapi/test_relaxng_to_codemirror.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/fastapi/test_relaxng_to_codemirror.py` (reuses the existing `FIXTURE_RNG` already defined in that file, which has `root` containing `bibl` (required, via plain `<ref>` inside the root's own `<choice>`-free direct children — check the actual fixture; if `root`'s children are all inside one `zeroOrMore(choice(...))`, add a small dedicated fixture instead, as below, to get an unambiguous required/optional/repeatable mix):

```python
    def test_extract_child_cardinality_distinguishes_required_optional_repeatable(self):
        """
        A child element's cardinality must reflect how it's reachable:
        - a bare, unwrapped <ref>/<element> is required and not repeatable.
        - inside <optional> (directly or via a <choice> branch), not required.
        - inside <oneOrMore>, required AND repeatable.
        - inside <zeroOrMore>, not required and repeatable.
        """
        fixture = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0" ns="http://example.org/ns">
  <define name="root">
    <element name="root">
      <ref name="always"/>
      <optional><ref name="sometimes"/></optional>
      <oneOrMore><ref name="several"/></oneOrMore>
      <zeroOrMore><ref name="any"/></zeroOrMore>
      <choice>
        <ref name="choiceA"/>
        <ref name="choiceB"/>
      </choice>
    </element>
  </define>
  <define name="always"><element name="always"><text/></element></define>
  <define name="sometimes"><element name="sometimes"><text/></element></define>
  <define name="several"><element name="several"><text/></element></define>
  <define name="any"><element name="any"><text/></element></define>
  <define name="choiceA"><element name="choiceA"><text/></element></define>
  <define name="choiceB"><element name="choiceB"><text/></element></define>
</grammar>"""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.rng', delete=False) as f:
            f.write(fixture)
            path = f.name
        try:
            parser = RelaxNGParser()
            parser.parse_file(path)
            root_element = parser._find_element_definition('root')
            cardinality = parser._extract_child_cardinality(root_element)
        finally:
            Path(path).unlink()

        self.assertEqual(cardinality['always'], {'required': True, 'repeatable': False})
        self.assertEqual(cardinality['sometimes'], {'required': False, 'repeatable': False})
        self.assertEqual(cardinality['several'], {'required': True, 'repeatable': True})
        self.assertEqual(cardinality['any'], {'required': False, 'repeatable': True})
        # Inside a <choice>, neither branch is individually required.
        self.assertEqual(cardinality['choiceA'], {'required': False, 'repeatable': False})
        self.assertEqual(cardinality['choiceB'], {'required': False, 'repeatable': False})

    def test_extract_tag_definitions_includes_child_cardinality(self):
        parser = RelaxNGParser()
        with tempfile.NamedTemporaryFile(mode='w', suffix='.rng', delete=False) as f:
            f.write(FIXTURE_RNG)
            path = f.name
        try:
            parser.parse_file(path)
            defs = parser.extract_tag_definitions('root')
        finally:
            Path(path).unlink()
        self.assertIn('childCardinality', defs['root'])
        self.assertIsInstance(defs['root']['childCardinality'], dict)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_relaxng_to_codemirror.py -v
```

Expected: `FAIL` — `AttributeError: 'RelaxNGParser' object has no attribute '_extract_child_cardinality'`.

- [ ] **Step 3: Implement `_extract_child_cardinality()`**

In `fastapi_app/lib/utils/relaxng_to_codemirror.py`, add the new `ChildCardinality` TypedDict at **module level**, alongside the existing `TagVariant`/`TagAttribute`/`TagDefinition` classes (not inside `RelaxNGParser`):

```python
class ChildCardinality(TypedDict):
    """Per-child-element cardinality, keyed by child tag name in `TagDefinition.childCardinality`."""
    required: bool
    repeatable: bool
```

Then add the following three **methods inside the `RelaxNGParser` class**, after `_extract_child_elements()` (after line ~301 — note the 4-space method indentation below, unlike the module-level `ChildCardinality` above):

```python
    def _is_child_required(self, container: ET.Element, child_name: str, visited: Optional[Set[str]] = None) -> bool:
        """
        True if `<element name=child_name>` (directly, or via `<ref>`) is a
        mandatory, unconditional descendant of `container` — reachable
        without passing through `<optional>`, `<choice>`, `<zeroOrMore>`, or
        an interleave sibling that could equally be absent. Mirrors
        `_is_attribute_required`'s traversal shape (group/interleave only;
        `<choice>`/`<optional>`/`<zeroOrMore>` are deliberately not
        descended into, since presence through any of those is conditional).
        """
        if visited is None:
            visited = set()
        for element in container.findall(f'./{RNG_NS}element'):
            if element.get('name') == child_name:
                return True
        for ref in container.findall(f'./{RNG_NS}ref'):
            ref_name = ref.get('name')
            if ref_name == child_name:
                return True
            if ref_name and ref_name in self.defined_patterns and ref_name not in visited:
                visited.add(ref_name)
                try:
                    if self._is_child_required(self.defined_patterns[ref_name], child_name, visited):
                        return True
                finally:
                    visited.discard(ref_name)
        for group in container.findall(f'./{RNG_NS}group'):
            if self._is_child_required(group, child_name, visited):
                return True
        for oneOrMore in container.findall(f'./{RNG_NS}oneOrMore'):
            if self._is_child_required(oneOrMore, child_name, visited):
                return True
        for interleave in container.findall(f'./{RNG_NS}interleave'):
            if self._is_child_required(interleave, child_name, visited):
                return True
        return False

    def _is_child_repeatable(self, container: ET.Element, child_name: str, visited: Optional[Set[str]] = None) -> bool:
        """
        True if `<element name=child_name>` is reachable through an
        `<oneOrMore>` or `<zeroOrMore>` anywhere on the path from
        `container` — i.e. the document may legally contain more than one.
        Unlike `_is_child_required`, this descends into every container
        type `_extract_child_elements` does (group/choice/optional/
        zeroOrMore/oneOrMore/interleave/ref), since repeatability doesn't
        care whether the *whole* branch is conditional.
        """
        if visited is None:
            visited = set()
        for repeat_tag in (f'{RNG_NS}oneOrMore', f'{RNG_NS}zeroOrMore'):
            for repeater in container.findall(f'./{repeat_tag}'):
                if child_name in self._extract_child_elements(repeater, set(visited)):
                    return True
        for inner_tag in (f'{RNG_NS}choice', f'{RNG_NS}group', f'{RNG_NS}optional',
                          f'{RNG_NS}zeroOrMore', f'{RNG_NS}oneOrMore', f'{RNG_NS}interleave'):
            for inner in container.findall(f'./{inner_tag}'):
                if self._is_child_repeatable(inner, child_name, visited):
                    return True
        for ref in container.findall(f'./{RNG_NS}ref'):
            ref_name = ref.get('name')
            if ref_name and ref_name in self.defined_patterns and ref_name not in visited:
                visited.add(ref_name)
                try:
                    if self._is_child_repeatable(self.defined_patterns[ref_name], child_name, visited):
                        return True
                finally:
                    visited.discard(ref_name)
        return False

    def _extract_child_cardinality(self, element: ET.Element) -> Dict[str, 'ChildCardinality']:
        """
        For every child tag name `_extract_child_elements(element)` reports,
        compute `{'required': bool, 'repeatable': bool}` relative to
        `element` itself (not the whole schema) — used by the teiHeader
        editor to decide which fields must be filled and which get an
        "add another" control.
        """
        children = self._extract_child_elements(element)
        return {
            name: {
                'required': self._is_child_required(element, name),
                'repeatable': self._is_child_repeatable(element, name),
            }
            for name in children
        }
```

- [ ] **Step 4: Wire it into `TagDefinition`/`extract_tag_definitions()`**

In the same file, update the `TagDefinition` class (around line 47):

```python
class TagDefinition(TypedDict):
    """Per-tag data returned by `extract_tag_definitions()`."""
    description: Optional[str]
    children: List[str]
    attributes: List[TagAttribute]
    variants: List[TagVariant]
    bareAllowed: bool
    childCardinality: Dict[str, 'ChildCardinality']
```

And in `extract_tag_definitions()` (around line 622, inside the `result[tag_name] = {...}` block), add the new key:

```python
            result[tag_name] = {
                'description': self._extract_documentation(element),
                'children': self._extract_child_elements(element),
                'attributes': attributes,
                'variants': variants,
                'bareAllowed': bare_allowed,
                'childCardinality': self._extract_child_cardinality(element),
            }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_relaxng_to_codemirror.py -v
```

Expected: all tests `PASS`, including the two new ones.

- [ ] **Step 6: Run the full existing suite for this file to check no regression**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_relaxng_to_codemirror.py -v
```

Expected: `PASS` (same command — confirms the new `childCardinality` key didn't break any existing assertion on the full `TagDefinition` shape; check for any `assertEqual(defs[...], {...})` style exact-dict comparisons in this file. If one exists, add `'childCardinality': ...` to its expected dict rather than changing it to an inexact comparison).

- [ ] **Step 7: Commit**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
git add fastapi_app/lib/utils/relaxng_to_codemirror.py tests/unit/fastapi/test_relaxng_to_codemirror.py
git commit -m "$(cat <<'EOF'
Add child-element cardinality extraction to RelaxNGParser

extract_tag_definitions() now reports, per reachable child tag,
whether it's required and/or repeatable relative to its parent -
needed by the upcoming teiHeader editor to mark required fields and
offer "add another" for repeatable ones, since document schemas (e.g.
GROBID's permissive training schemas) often can't express this
themselves.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Backend — extract shared schema-resolution helper

**Files:**
- Modify: `fastapi_app/routers/validation.py`
- Test: `tests/unit/fastapi/test_validation_router.py` (check first whether this file already exists; if an existing test file covers `/autocomplete-data` under a different name, extend that one instead of creating a new one)

- [ ] **Step 1: Check for an existing test file covering `/validate/autocomplete-data`**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
grep -rl "autocomplete-data\|generate_autocomplete_data" tests/unit/fastapi/
```

If a file is found, use it for the rest of this task instead of creating `test_validation_router.py`; adjust the remaining steps' file path accordingly.

- [ ] **Step 2: Write the failing test for the extracted helper**

Add (to whichever file Step 1 resolved to):

```python
from fastapi_app.routers.validation import resolve_document_schema_cache_file

class TestResolveDocumentSchemaCacheFile(unittest.TestCase):
    def test_raises_on_missing_schema_location(self):
        with self.assertRaises(HTTPException) as ctx:
            resolve_document_schema_cache_file(
                '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>',
                cache_root=Path(tempfile.mkdtemp()),
                invalidate_cache=False,
            )
        self.assertEqual(ctx.exception.status_code, 400)
```

(Add `from fastapi import HTTPException`, `import tempfile`, `from pathlib import Path` to the test file's imports if not already present.)

- [ ] **Step 3: Run the test to verify it fails**

```bash
uv run python tests/unit-test-runner.py <resolved_test_file_path> -v
```

Expected: `FAIL` — `ImportError: cannot import name 'resolve_document_schema_cache_file'`.

- [ ] **Step 4: Extract the helper**

In `fastapi_app/routers/validation.py`, replace the inline resolution block inside `generate_autocomplete_data()` (the block from `schema_locations = extract_schema_locations(...)` through `download_schema_file(...)`/cache-file selection, roughly lines 124–178) with a call to a new module-level function, and move that logic into the function itself:

```python
def resolve_document_schema_cache_file(xml_string: str, cache_root: Path, invalidate_cache: bool) -> Path:
    """
    Resolve "the schema that governs this document" to its locally cached
    RelaxNG file path, downloading it first if needed. Shared by
    /autocomplete-data and /teiheader-structure - both need exactly this
    resolution (schema location from the XML, RelaxNG preferred, cache
    lookup, download-if-missing/invalidated).

    Raises HTTPException(400) if no schema location is found, or the
    location doesn't start with "http"; HTTPException(503) if invalidation
    was requested without internet; HTTPException(404) if the schema
    download 404s.
    """
    if invalidate_cache and not has_internet():
        raise HTTPException(
            status_code=503,
            detail="Cannot invalidate cache without internet connection. Schema re-download requires network access."
        )

    schema_locations = extract_schema_locations(xml_string)
    if not schema_locations:
        logger.debug('No schema location found in XML, cannot resolve document schema.')
        raise HTTPException(status_code=400, detail="No schema location found in XML document")

    schema_info = next((sl for sl in schema_locations if sl.get('type') == 'relaxng'), schema_locations[0])
    schema_location = schema_info['schemaLocation']
    if not schema_location.startswith("http"):
        raise HTTPException(status_code=400, detail=f"Schema location must start with 'http': {schema_location}")

    schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(schema_location, cache_root)

    if not schema_cache_file.is_file() or invalidate_cache:
        from ..lib.core.schema_validator import download_schema_file
        try:
            download_schema_file(schema_location, schema_cache_dir, schema_cache_file)
        except Exception as e:
            if "404" in str(e) or "Not Found" in str(e):
                raise HTTPException(status_code=404, detail=f"Schema not found: {schema_location}")
            raise
    else:
        logger.debug(f"Using cached schema at {schema_cache_file}")

    return schema_cache_file
```

Then simplify `generate_autocomplete_data()`'s body to call it:

```python
    try:
        schema_cache_file = resolve_document_schema_cache_file(
            request.xml_string, settings.schema_cache_dir, request.invalidate_cache
        )
        schema_cache_dir = schema_cache_file.parent
        autocomplete_cache_file = schema_cache_dir / 'codemirror-autocomplete.json'

        if autocomplete_cache_file.is_file() and not request.invalidate_cache:
            logger.debug(f"Using cached autocomplete data at {autocomplete_cache_file}")
            with open(autocomplete_cache_file, 'r', encoding='utf-8') as f:
                autocomplete_data = json.load(f)
                return AutocompleteDataResponse(data=autocomplete_data)
```

(continue with the existing parse/build/cache-write logic that follows the old block unchanged — only the resolution portion moves into the helper; the HTTPException raised for "already a 404 schema download" etc. propagates unchanged since `resolve_document_schema_cache_file` raises the same `HTTPException` types the route already caught via its surrounding `try`/`except ValidationError`/`except Exception`).

- [ ] **Step 5: Run the test to verify it passes, plus the existing autocomplete-data tests**

```bash
uv run python tests/unit-test-runner.py <resolved_test_file_path> -v
```

Expected: all `PASS`.

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/routers/validation.py <resolved_test_file_path>
git commit -m "$(cat <<'EOF'
Extract document-schema resolution into a shared helper

resolve_document_schema_cache_file() factors the
"find the document's schema location, download/cache it" logic out of
generate_autocomplete_data() so the upcoming /teiheader-structure
endpoint can reuse it instead of duplicating it.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Backend — `/validate/teiheader-structure` endpoint

**Files:**
- Modify: `fastapi_app/lib/models/models_validation.py`
- Modify: `fastapi_app/routers/validation.py`
- Test: same test file resolved in Task 3

- [ ] **Step 1: Write the failing test**

```python
class TestTeiHeaderStructureEndpoint(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)  # match this test file's existing app/client setup pattern

    def test_merges_document_schema_with_core_fallback(self):
        xml = '''<?xml-model href="https://example.org/missing-schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title/></titleStmt></fileDesc></teiHeader></TEI>'''
        # The document's own schema location 404s/is unreachable in this
        # unit test (no network dependency) - response must still succeed,
        # built entirely from the bundled core schema.
        response = self.client.post("/api/v1/validate/teiheader-structure", json={"xml_string": xml})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(set(data["roots"]), {"titleStmt", "publicationStmt", "sourceDesc"})
        self.assertIn("title", data["tags"])
        self.assertTrue(data["tags"]["title"]["description"])
        self.assertNotIn("respStmt", data["tags"]["titleStmt"]["children"])
        self.assertTrue(data["tags"]["titleStmt"]["childCardinality"]["title"]["required"])
        # Two hops from sourceDesc (sourceDesc -> biblStruct -> analytic) -
        # must still appear as its own entry with its own children, not be
        # flattened into a leaf (see _collect_merged_defs()'s doc comment).
        self.assertIn("biblStruct", data["tags"]["sourceDesc"]["children"])
        self.assertIn("analytic", data["tags"]["biblStruct"]["children"])
        self.assertIn("analytic", data["tags"])
        self.assertTrue(data["tags"]["analytic"]["children"])
```

(Adjust the `TestClient`/app-fixture setup to match whatever pattern this test file's existing tests already use — check the file's existing imports/`setUp()` before writing this, per `docs/code-assistant/testing-guide.md`'s dependency-override pattern for authenticated routes if this endpoint ends up requiring auth, matching `/autocomplete-data`'s own `Depends(require_authenticated_user)`.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run python tests/unit-test-runner.py <resolved_test_file_path> -v
```

Expected: `FAIL` — 404 (route doesn't exist yet).

- [ ] **Step 3: Add the Pydantic models**

In `fastapi_app/lib/models/models_validation.py`:

```python
class TeiHeaderStructureRequest(BaseModel):
    """Request for the schema-derived teiHeader field structure."""
    xml_string: str = Field(..., description="XML document to resolve the governing schema from", min_length=1)


class ChildCardinalityModel(BaseModel):
    """Whether a child tag is mandatory and/or may occur more than once, relative to its parent."""
    required: bool
    repeatable: bool


class TeiHeaderTagDefinitionModel(BaseModel):
    """One tag's schema-derived data, merged from the document's own schema and the bundled core TEI schema."""
    description: Optional[str] = None
    children: List[str] = Field(default_factory=list)
    attributes: List[Dict[str, Any]] = Field(default_factory=list)
    childCardinality: Dict[str, ChildCardinalityModel] = Field(default_factory=dict)


class TeiHeaderStructureResponse(BaseModel):
    """Schema-derived structure for the teiHeader editor's titleStmt/publicationStmt/sourceDesc sections."""
    roots: List[str]
    tags: Dict[str, TeiHeaderTagDefinitionModel]
```

- [ ] **Step 4: Implement the endpoint**

In `fastapi_app/routers/validation.py`, add near the top (module-level, parsed once):

```python
from pathlib import Path as _Path

_CORE_SCHEMA_PATH = _Path(__file__).resolve().parent.parent.parent / "schema" / "rng" / "tei-bib.rng"
_core_schema_parser: Optional["RelaxNGParser"] = None


def _get_core_schema_parser():
    """Lazily parse the bundled core TEI schema once per process."""
    global _core_schema_parser
    if _core_schema_parser is None:
        from ..lib.utils.relaxng_to_codemirror import RelaxNGParser
        parser = RelaxNGParser()
        parser.parse_file(str(_CORE_SCHEMA_PATH))
        _core_schema_parser = parser
    return _core_schema_parser
```

**Important, found by running this against the real schema rather than just
reasoning about it:** `extract_tag_definitions(root_tag)` only resolves
names one hop away from `root_tag` itself. Calling it with
`root_tag='sourceDesc'` discovers `biblStruct` as a child name (and gives
`biblStruct` its own correct `description`/`children` in the result), but
does **not** also add `biblStruct`'s own children (`analytic`, `monogr`)
as top-level keys in the same result — those are two hops from `sourceDesc`,
and nothing re-expands a newly-discovered tag's own `children` list into a
further `extract_tag_definitions()` call. Calling it separately per root
once, as a naive implementation would, silently flattens `biblStruct`'s
nested author/title/imprint fields into undocumented leaves client-side.
The fix is a small BFS over repeated calls, expanding the frontier through
each result's own `children` lists:

```python
def _collect_merged_defs(parser, roots: List[str], exclude: Set[str], max_depth: int = 6) -> Dict[str, Dict]:
    """
    BFS over RelaxNGParser.extract_tag_definitions(): each call only
    resolves ITS OWN root tag's children one hop deep by name, without
    recursively expanding those child names into their own entries (see
    this function's call site for how this was discovered). Keeps calling
    extract_tag_definitions() on every newly-discovered tag name - each
    such call correctly resolves that tag's own real <element> via
    _find_element_definition(), so its `children` are accurate for ITS
    level - until no new tag names appear or `max_depth` hops is reached.
    """
    merged: Dict[str, Dict] = {}
    frontier = list(roots)
    depth = 0
    while frontier and depth < max_depth:
        next_frontier: List[str] = []
        for tag_name in frontier:
            if tag_name in merged or tag_name in exclude:
                continue
            for name, data in parser.extract_tag_definitions(tag_name, exclude=exclude).items():
                if name not in merged:
                    merged[name] = data
                    next_frontier.extend(data.get('children', []))
        frontier = next_frontier
        depth += 1
    return merged
```

And the route itself, below `generate_autocomplete_data()`:

```python
_TEIHEADER_ROOTS = ["titleStmt", "publicationStmt", "sourceDesc"]
_TEIHEADER_EXCLUDE = {"respStmt"}


@router.post("/teiheader-structure", response_model=TeiHeaderStructureResponse)
def generate_teiheader_structure(
    request: TeiHeaderStructureRequest,
    settings=Depends(get_settings),
    user: dict = Depends(require_authenticated_user)
) -> TeiHeaderStructureResponse:
    """
    Schema-derived field structure for the teiHeader editor's
    titleStmt/publicationStmt/sourceDesc sections, merging the open
    document's own resolved schema with the bundled core TEI schema
    (schema/rng/tei-bib.rng): a tag's description/children/attributes come
    from the document schema where present, else the core schema; a tag
    reachable only in the core schema is included anyway; cardinality
    (required/repeatable) always comes from the core schema, since
    permissive document schemas (e.g. GROBID's training schemas) don't
    reliably encode it. titleStmt/respStmt is always excluded - it's this
    app's own user registry, not bibliographic data.
    """
    from ..lib.utils.relaxng_to_codemirror import RelaxNGParser

    core_parser = _get_core_schema_parser()
    core_defs = _collect_merged_defs(core_parser, _TEIHEADER_ROOTS, _TEIHEADER_EXCLUDE)

    doc_defs: Dict[str, Dict] = {}
    try:
        schema_cache_file = resolve_document_schema_cache_file(
            request.xml_string, settings.schema_cache_dir, invalidate_cache=False
        )
        doc_parser = RelaxNGParser()
        doc_parser.parse_file(str(schema_cache_file))
        doc_defs = _collect_merged_defs(doc_parser, _TEIHEADER_ROOTS, _TEIHEADER_EXCLUDE)
    except HTTPException:
        # No/unreachable document schema - fall back to the core schema
        # alone (see this function's docstring); not a client error.
        pass

    merged: Dict[str, Dict] = {}
    for tag_name, core_def in core_defs.items():
        doc_def = doc_defs.get(tag_name)
        merged[tag_name] = {
            "description": (doc_def or {}).get("description") or core_def.get("description"),
            "children": (doc_def or {}).get("children") or core_def.get("children", []),
            "attributes": (doc_def or {}).get("attributes") or core_def.get("attributes", []),
            # Cardinality always from the core schema (product decision).
            "childCardinality": core_def.get("childCardinality", {}),
        }
    # Tags present only in the document schema (not reachable from the core
    # schema's own titleStmt/publicationStmt/sourceDesc closure) are not
    # included - the core schema is authoritative for which tags exist in
    # this editor's scope.

    return TeiHeaderStructureResponse(roots=_TEIHEADER_ROOTS, tags=merged)
```

Add `TeiHeaderStructureRequest, TeiHeaderStructureResponse` to the existing `from ..lib.models.models_validation import (...)` block at the top of the file.

- [ ] **Step 5: Run the test to verify it passes**

```bash
uv run python tests/unit-test-runner.py <resolved_test_file_path> -v
```

Expected: `PASS`.

- [ ] **Step 6: Register the route**

Check `fastapi_app/main.py:250` — `api_v1.include_router(validation.router)` already covers this new route since it's added to the same `router` object; no change needed. Confirm by running:

```bash
uv run uvicorn fastapi_app.main:app --port 8999 &
sleep 2
curl -s http://localhost:8999/openapi.json | python3 -c "import json,sys; print('/api/v1/validate/teiheader-structure' in json.load(sys.stdin)['paths'])"
kill %1
```

Expected: `True`.

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/lib/models/models_validation.py fastapi_app/routers/validation.py <resolved_test_file_path>
git commit -m "$(cat <<'EOF'
Add /validate/teiheader-structure endpoint

Returns schema-derived field descriptions, children, and cardinality
for titleStmt/publicationStmt/sourceDesc, merging the open document's
own schema with the bundled core TEI schema as a fallback - the data
source for the upcoming teiHeader editor dialog.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Frontend — API client method

**Files:**
- Modify: `app/src/modules/api-client-v1.js`

- [ ] **Step 1: Add the typedefs**

Near the existing `AutocompleteDataRequest`/`AutocompleteDataResponse` typedefs (around line 86):

```js
/**
 * @typedef {Object} TeiHeaderStructureRequest
 * @property {string} xml_string - XML document to resolve the governing schema from
 */

/**
 * @typedef {Object} ChildCardinality
 * @property {boolean} required
 * @property {boolean} repeatable
 */

/**
 * @typedef {Object} TeiHeaderAttribute
 * @property {string} name
 * @property {Array<string>=} values
 * @property {boolean} required
 */

/**
 * @typedef {Object} TeiHeaderTagDefinition
 * @property {string=} description
 * @property {Array<string>} children
 * @property {Array<TeiHeaderAttribute>} attributes
 * @property {Object<string, ChildCardinality>} childCardinality
 */

/**
 * @typedef {Object} TeiHeaderStructureResponse
 * @property {Array<string>} roots
 * @property {Object<string, TeiHeaderTagDefinition>} tags
 */
```

- [ ] **Step 2: Add the client method**

Near `validateAutocompleteData()` (around line 1478):

```js
  /**
   * Schema-derived field structure for the teiHeader editor's
   * titleStmt/publicationStmt/sourceDesc sections.
   *
   * @param {TeiHeaderStructureRequest} requestBody
   * @returns {Promise<TeiHeaderStructureResponse>}
   */
  async validateTeiheaderStructure(requestBody) {
    const endpoint = `/validate/teiheader-structure`
    return this.callApi(endpoint, 'POST', requestBody);
  }
```

- [ ] **Step 3: Sanity-check the file still parses**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
node --check app/src/modules/api-client-v1.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/api-client-v1.js
git commit -m "$(cat <<'EOF'
Add validateTeiheaderStructure() to the API client

Mirrors the new /validate/teiheader-structure backend endpoint.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend — pure form-tree builder module

**Files:**
- Create: `app/src/modules/tei-header-form.js`
- Test: `tests/unit/js/tei-header-form.test.js`

This module has no DOM/Shoelace/plugin dependencies - it's pure data transformation, kept separate from the plugin so it's unit-testable without jsdom or a live editor.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/js/tei-header-form.test.js`:

```js
#!/usr/bin/env node

/**
 * @testCovers app/src/modules/tei-header-form.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildFieldTree } from '../../../app/src/modules/tei-header-form.js';

/** @type {import('../../../app/src/modules/api-client-v1.js').TeiHeaderStructureResponse} */
const FIXTURE_STRUCTURE = {
  roots: ['titleStmt'],
  tags: {
    titleStmt: {
      description: 'title statement',
      children: ['title'],
      attributes: [],
      childCardinality: { title: { required: true, repeatable: false } }
    },
    title: {
      description: 'the title of a work',
      children: [],
      attributes: [{ name: 'level', values: ['a', 'm', 'j'], required: false }],
      childCardinality: {}
    }
  }
};

describe('buildFieldTree', () => {
  it('builds a nested tree with leaf fields and required/repeatable flags', () => {
    const tree = buildFieldTree(FIXTURE_STRUCTURE);
    assert.strictEqual(tree.length, 1);
    const [titleStmt] = tree;
    assert.strictEqual(titleStmt.tag, 'titleStmt');
    assert.strictEqual(titleStmt.children.length, 1);
    const [title] = titleStmt.children;
    assert.strictEqual(title.tag, 'title');
    assert.strictEqual(title.isLeaf, true);
    assert.strictEqual(title.required, true);
    assert.strictEqual(title.repeatable, false);
    assert.strictEqual(title.attributes[0].name, 'level');
  });

  it('caps recursion depth at 6 levels to guard against schema cycles', () => {
    /** @type {any} */
    const cyclicStructure = {
      roots: ['a'],
      tags: {
        a: { description: null, children: ['a'], attributes: [], childCardinality: { a: { required: false, repeatable: true } } }
      }
    };
    const tree = buildFieldTree(cyclicStructure);
    let depth = 0;
    let node = tree[0];
    while (node.children && node.children[0]) {
      node = node.children[0];
      depth += 1;
    }
    assert.ok(depth <= 6, `depth was ${depth}, expected <= 6`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
node tests/unit-test-runner.js tests/unit/js/tei-header-form.test.js
```

Expected: `FAIL` — module not found.

- [ ] **Step 3: Implement `tei-header-form.js`**

```js
/**
 * Pure (no DOM, no plugin deps) helpers for the teiHeader editor: turn a
 * /validate/teiheader-structure response into a nested field tree the
 * dialog can render recursively.
 */

/**
 * @import { TeiHeaderStructureResponse, TeiHeaderTagDefinition } from './api-client-v1.js'
 */

const MAX_DEPTH = 6

/**
 * @typedef {Object} FieldNode
 * @property {string} tag
 * @property {string=} description
 * @property {boolean} isLeaf
 * @property {boolean} required
 * @property {boolean} repeatable
 * @property {Array<{name: string, values: Array<string>|null, required: boolean}>} attributes
 * @property {Array<FieldNode>} children
 */

/**
 * Build the nested field tree for every root in `structure.roots`.
 * @param {TeiHeaderStructureResponse} structure
 * @returns {Array<FieldNode>}
 */
export function buildFieldTree(structure) {
  return structure.roots.map((root) => buildNode(structure, root, true, false, new Set(), 0))
}

/**
 * @param {TeiHeaderStructureResponse} structure
 * @param {string} tag
 * @param {boolean} required
 * @param {boolean} repeatable
 * @param {Set<string>} ancestors - guards against a schema cycle (tag appearing in its own descendant chain)
 * @param {number} depth
 * @returns {FieldNode}
 */
function buildNode(structure, tag, required, repeatable, ancestors, depth) {
  /** @type {TeiHeaderTagDefinition|undefined} */
  const def = structure.tags[tag]
  const children = def?.children ?? []
  const atMaxDepth = depth >= MAX_DEPTH
  const isCycle = ancestors.has(tag)
  const isLeaf = children.length === 0 || atMaxDepth || isCycle

  /** @type {Array<FieldNode>} */
  let childNodes = []
  if (!isLeaf) {
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(tag)
    childNodes = children.map((childTag) => {
      const cardinality = def?.childCardinality?.[childTag] ?? { required: false, repeatable: false }
      return buildNode(structure, childTag, cardinality.required, cardinality.repeatable, nextAncestors, depth + 1)
    })
  }

  return {
    tag,
    description: def?.description,
    isLeaf,
    required,
    repeatable,
    attributes: def?.attributes ?? [],
    children: childNodes
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/unit-test-runner.js tests/unit/js/tei-header-form.test.js
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/tei-header-form.js tests/unit/js/tei-header-form.test.js
git commit -m "$(cat <<'EOF'
Add pure field-tree builder for the teiHeader editor

buildFieldTree() turns a /validate/teiheader-structure response into a
nested, render-ready tree (leaf vs. section, required/repeatable per
node), with a depth cap guarding against schema reference cycles. Kept
dependency-free so it's unit-testable without jsdom or a live editor.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Frontend — dialog template

**Files:**
- Create: `app/src/templates/tei-header-editor-dialog.html`
- Create: `app/src/templates/tei-header-editor-dialog.types.js`
- Modify: `app/src/ui.js`

- [ ] **Step 1: Create the template**

Only static chrome; each root's section content is built at runtime by the plugin from `buildFieldTree()`'s output.

```html
<sl-dialog name="teiHeaderEditorDialog" label="Edit header metadata" style="--width: 60vw;">
  <div name="sectionsContainer"></div>

  <div slot="footer" style="display: flex; justify-content: flex-end; gap: 0.5rem; width: 100%;">
    <sl-button name="cancelBtn" size="small">Cancel</sl-button>
    <sl-button name="saveBtn" size="small" variant="primary">Save</sl-button>
  </div>
</sl-dialog>
```

- [ ] **Step 2: Create the types file**

Follow the pattern of an existing simple dialog's `.types.js` (e.g. check `app/src/templates/document-rules-editor-dialog.types.js` for the exact shape expected by `createNavigableElement`/`ui.js`, then mirror it):

```js
/**
 * @import { SlDialog, SlButton } from '../ui.js'
 */

/**
 * @typedef {Object} teiHeaderEditorDialogPart
 * @property {HTMLElement} sectionsContainer
 * @property {SlButton} cancelBtn
 * @property {SlButton} saveBtn
 */
```

- [ ] **Step 3: Register the typedef in `app/src/ui.js`**

Mirror `document-rules-editor-dialog`'s exact wiring (confirmed in
`app/src/ui.js:67` and `:102`): it's a standalone dialog attached to
`document.body`, not nested under the toolbar, so it gets a top-level
property on the root `ui` typedef. Add the import alongside the existing
one at line 67:

```js
 * @import {teiHeaderEditorDialogPart} from './templates/tei-header-editor-dialog.types.js'
```

and a property alongside `documentRulesEditorDialog` at line 102:

```js
 * @property {UIPart<SlDialog, teiHeaderEditorDialogPart>} [teiHeaderEditorDialog] - TEI header editor dialog (added by tei-header-editor plugin)
```

- [ ] **Step 4: Verify the template parses as valid HTML and the typedef resolves**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
node -e "
import('jsdom').then(({JSDOM}) => {
  const fs = require('fs');
  const html = fs.readFileSync('app/src/templates/tei-header-editor-dialog.html', 'utf-8');
  const dom = new JSDOM('<!DOCTYPE html><body>' + html + '</body>');
  const dialog = dom.window.document.querySelector('sl-dialog[name=teiHeaderEditorDialog]');
  console.log('dialog found:', !!dialog);
  console.log('saveBtn found:', !!dialog.querySelector('[name=saveBtn]'));
});
"
```

Expected: both `true`.

- [ ] **Step 5: Commit**

```bash
git add app/src/templates/tei-header-editor-dialog.html app/src/templates/tei-header-editor-dialog.types.js app/src/ui.js
git commit -m "$(cat <<'EOF'
Add teiHeader editor dialog template

Static sl-dialog chrome; per-root section content is built at runtime
by TeiHeaderEditorPlugin from the schema-derived field tree.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Frontend — `TeiHeaderEditorPlugin` skeleton, toolbar button, role gating

**Files:**
- Create: `app/src/plugins/tei-header-editor.js`
- Modify: `app/src/plugins.js`

- [ ] **Step 1: Create the plugin**

```js
/**
 * TEI Header Editor Plugin
 *
 * Adds a toolbar button to the XML editor that opens a schema-driven
 * dialog for editing fileDesc/titleStmt, fileDesc/publicationStmt, and
 * fileDesc/sourceDesc. Hidden for pure annotators (acl-utils.js's
 * userIsAnnotatorOnly()), matching the existing teiHeader-visibility
 * safeguard in tei-tools.js.
 *
 * See docs/superpowers/specs/2026-10-07-teiheader-editor-plugin-design.md.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { SlDialog } from '../ui.js'
 * @import { teiHeaderEditorDialogPart } from '../templates/tei-header-editor-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { PanelUtils } from '../modules/panels/index.js'
import { userIsAnnotatorOnly } from '../modules/acl-utils.js'

await registerTemplate('tei-header-editor-dialog', 'tei-header-editor-dialog.html')

class TeiHeaderEditorPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'tei-header-editor', deps: ['xmleditor', 'client', 'logger'] })
  }

  get #xmlEditorApi() { return this.getDependency('xmleditor') }
  get #client() { return this.getDependency('client') }

  /** @type {StatusButton} */
  #headerEditorBtn

  /** @type {SlDialog & teiHeaderEditorDialogPart} */
  #dialogUi

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.getDependency('logger').debug('Installing plugin "tei-header-editor"')

    this.#headerEditorBtn = PanelUtils.createButton({
      icon: 'card-heading',
      tooltip: 'Edit header metadata',
      name: 'headerEditorBtn'
    })
    this.#xmlEditorApi.addToolbarWidget(this.#headerEditorBtn, 1)

    this.#dialogUi = this.createUi(createSingleFromTemplate('tei-header-editor-dialog', document.body))
  }

  async start() {
    this.getDependency('logger').debug('Starting plugin "tei-header-editor"')
    this.#headerEditorBtn.addEventListener('widget-click', () => this.#onOpen())
    this.#dialogUi.cancelBtn.addEventListener('click', () => this.#dialogUi.hide())
  }

  async onStateUpdate(_changedKeys) {
    const hasDocument = !!this.state.xml
    const isAnnotatorOnly = userIsAnnotatorOnly(this.state.user)
    this.#headerEditorBtn.disabled = !hasDocument
    this.#headerEditorBtn.style.display = isAnnotatorOnly ? 'none' : ''
  }

  async #onOpen() {
    // Task 9 fills this in: fetch structure, populate from the live DOM, show the dialog.
  }
}

export default TeiHeaderEditorPlugin

export const plugin = TeiHeaderEditorPlugin
```

- [ ] **Step 2: Register it in `app/src/plugins.js`**

Add `TeiHeaderEditorPlugin` to the import block (alphabetical, next to `TeiToolsPlugin`/`TeiValidationPlugin`) and to the `plugins` array, placed right after `TeiToolsPlugin` (both touch the XML editor toolbar/teiHeader):

```js
  TeiHeaderEditorPlugin,  // Edit header metadata (fileDesc) from the XML editor toolbar
```

- [ ] **Step 3: Verify the app still starts (manual dev-server check)**

This repo's dev server auto-reloads; per project rules, do not start/restart it yourself. Instead:

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
node --check app/src/plugins/tei-header-editor.js
node --check app/src/plugins.js
```

Expected: no output (both parse). Ask the user to confirm the button appears (hidden for annotator, visible/disabled-without-document otherwise) in a running instance, or use `node scripts/dev/ui-screenshot.js` per the project's UI-screenshot workflow once Task 9 makes the button functional enough to be worth a screenshot.

- [ ] **Step 4: Commit**

```bash
git add app/src/plugins/tei-header-editor.js app/src/plugins.js
git commit -m "$(cat <<'EOF'
Add TeiHeaderEditorPlugin skeleton with toolbar button

Adds the XML-editor toolbar button and role gating (hidden for pure
annotators, matching the existing teiHeader-visibility safeguard); the
dialog's actual content comes in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Frontend — populate dialog, recursive rendering, save/writeback

**Files:**
- Modify: `app/src/plugins/tei-header-editor.js`
- Modify: `app/src/modules/tei-header-form.js` (add the DOM-read/DOM-write helpers alongside `buildFieldTree`)
- Modify: `tests/unit/js/tei-header-form.test.js`

- [ ] **Step 1: Write the failing tests for the DOM helpers**

Add to `tests/unit/js/tei-header-form.test.js` (uses `jsdom`, already a project dependency per other tests in this directory):

```js
import { JSDOM } from 'jsdom';
import { readFieldValues, applyFieldValues } from '../../../app/src/modules/tei-header-form.js';

describe('readFieldValues / applyFieldValues', () => {
  const NS = 'http://www.tei-c.org/ns/1.0';

  it('reads an existing leaf value by tag path', () => {
    const dom = new JSDOM(`<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><titleStmt><title>Existing title</title></titleStmt></fileDesc></teiHeader></TEI>`, { contentType: 'text/xml' });
    const titleStmt = dom.window.document.getElementsByTagName('titleStmt')[0];
    const tree = [{ tag: 'title', isLeaf: true, required: true, repeatable: false, attributes: [], children: [] }];
    const values = readFieldValues(tree, titleStmt);
    assert.strictEqual(values.title[0].text, 'Existing title');
  });

  it('creates missing elements on write, and skips untouched optional sections', () => {
    const dom = new JSDOM(`<?xml version="1.0"?><TEI xmlns="${NS}"><teiHeader><fileDesc><titleStmt/></fileDesc></teiHeader></TEI>`, { contentType: 'text/xml' });
    const titleStmt = dom.window.document.getElementsByTagName('titleStmt')[0];
    const tree = [{ tag: 'title', isLeaf: true, required: true, repeatable: false, attributes: [], children: [] }];
    applyFieldValues(tree, titleStmt, { title: [{ text: 'New title', attrs: {} }] }, NS);
    const titleEl = titleStmt.getElementsByTagName('title')[0];
    assert.strictEqual(titleEl.textContent, 'New title');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node tests/unit-test-runner.js tests/unit/js/tei-header-form.test.js
```

Expected: `FAIL` — `readFieldValues`/`applyFieldValues` not exported.

- [ ] **Step 3: Implement the DOM helpers in `tei-header-form.js`**

Also extend the `FieldNode` typedef from Task 6 with the optional `el`
property the plugin attaches at render time (documentation only — the
builder itself never sets it):

```js
 * @property {HTMLElement=} el - set by TeiHeaderEditorPlugin#renderSection() at render time; absent until then
```

Append:

```js
/**
 * @typedef {Object} FieldValue
 * @property {string} text
 * @property {Object<string, string>} attrs
 */

/**
 * Read current values for every leaf in `tree` out of `scopeNode` (e.g. the
 * live titleStmt/publicationStmt/sourceDesc DOM element, from
 * xmlEditorApi.getXmlTree()). A repeatable leaf gets one entry per existing
 * element instance; a non-repeatable leaf gets at most one.
 * @param {Array<import('./tei-header-form.js').FieldNode>} tree
 * @param {Element} scopeNode
 * @returns {Object<string, Array<FieldValue>>}
 */
export function readFieldValues(tree, scopeNode) {
  /** @type {Object<string, Array<FieldValue>>} */
  const values = {}
  for (const node of tree) {
    if (node.isLeaf) {
      const matches = [...scopeNode.children].filter((el) => el.localName === node.tag)
      values[node.tag] = matches.map((el) => ({
        text: el.textContent ?? '',
        attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]))
      }))
    } else {
      const child = [...scopeNode.children].find((el) => el.localName === node.tag)
      if (child) Object.assign(values, readFieldValues(node.children, child))
    }
  }
  return values
}

/**
 * Mutate `scopeNode` so it matches `values`, creating ancestor/leaf
 * elements that don't exist yet only for leaves present (non-empty) in
 * `values` - a section the user never touched gets no new elements.
 * @param {Array<import('./tei-header-form.js').FieldNode>} tree
 * @param {Element} scopeNode
 * @param {Object<string, Array<FieldValue>>} values
 * @param {string} namespaceUri
 */
export function applyFieldValues(tree, scopeNode, values, namespaceUri) {
  const doc = scopeNode.ownerDocument
  for (const node of tree) {
    if (node.isLeaf) {
      const existing = [...scopeNode.children].filter((el) => el.localName === node.tag)
      const wanted = (values[node.tag] ?? []).filter((v) => v.text.trim() !== '')
      existing.forEach((el) => scopeNode.removeChild(el))
      for (const value of wanted) {
        const el = doc.createElementNS(namespaceUri, node.tag)
        el.textContent = value.text
        for (const [name, val] of Object.entries(value.attrs ?? {})) el.setAttribute(name, val)
        scopeNode.appendChild(el)
      }
    } else {
      const hasAnyValue = leavesHaveValues(node.children, values)
      let child = [...scopeNode.children].find((el) => el.localName === node.tag)
      if (!child && hasAnyValue) {
        child = doc.createElementNS(namespaceUri, node.tag)
        scopeNode.appendChild(child)
      }
      if (child) applyFieldValues(node.children, child, values, namespaceUri)
    }
  }
}

/**
 * @param {Array<import('./tei-header-form.js').FieldNode>} tree
 * @param {Object<string, Array<FieldValue>>} values
 * @returns {boolean}
 */
function leavesHaveValues(tree, values) {
  return tree.some((node) =>
    node.isLeaf
      ? (values[node.tag] ?? []).some((v) => v.text.trim() !== '')
      : leavesHaveValues(node.children, values)
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node tests/unit-test-runner.js tests/unit/js/tei-header-form.test.js
```

Expected: `PASS`.

- [ ] **Step 5: Wire it into the plugin's `#onOpen()`/Save**

Replace the placeholder in `app/src/plugins/tei-header-editor.js`:

```js
  /**
   * @import { FieldNode, FieldValue } from '../modules/tei-header-form.js'
   */
```

(add to the existing `@import` block at the top), and:

```js
import { buildFieldTree, readFieldValues, applyFieldValues } from '../modules/tei-header-form.js'

// ... inside the class:

  /** @type {Array<FieldNode>} */
  #fieldTree = []

  async #onOpen() {
    const xmlTree = this.#xmlEditorApi.getXmlTree()
    if (!xmlTree) return
    let structure
    try {
      structure = await this.#client.apiClient.validateTeiheaderStructure({ xml_string: this.state.xml ?? '' })
    } catch (error) {
      this.getDependency('logger').warn(`tei-header-editor: could not load schema structure: ${String(error)}`)
      return
    }
    this.#fieldTree = buildFieldTree(structure)
    this.#renderSections(xmlTree)
    await this.#dialogUi.show()
  }

  /**
   * @param {Document} xmlTree
   */
  #renderSections(xmlTree) {
    const container = this.#dialogUi.sectionsContainer
    container.innerHTML = ''
    const fileDesc = xmlTree.getElementsByTagName('fileDesc')[0]
    for (const rootNode of this.#fieldTree) {
      const scopeNode = fileDesc ? [...fileDesc.children].find((el) => el.localName === rootNode.tag) : undefined
      const values = scopeNode ? readFieldValues(rootNode.children, scopeNode) : {}
      container.appendChild(this.#renderSection(rootNode, values))
    }
  }
```

`#renderSection(node, values)` builds the recursive markup and stashes each
node's rendered element on the node itself (`node.el`) — `buildFieldTree()`
returns a fresh tree on every `#onOpen()`, so annotating it in place is safe
and avoids re-querying the DOM by tag name/text later (fragile once two
sibling sections share a tag name at different depths):

```js
  /**
   * @param {FieldNode} node
   * @param {Object<string, Array<FieldValue>>} values
   * @returns {HTMLElement}
   */
  #renderSection(node, values) {
    if (node.isLeaf) {
      node.el = this.#renderLeafGroup(node, values[node.tag] ?? [])
      return node.el
    }
    const details = document.createElement('sl-details')
    details.summary = node.tag
    if (node.description) details.title = node.description
    for (const child of node.children) details.appendChild(this.#renderSection(child, values))
    node.el = details
    return details
  }

  /**
   * One repeatable group of input rows for a leaf tag.
   * @param {FieldNode} node
   * @param {Array<FieldValue>} entries
   * @returns {HTMLElement}
   */
  #renderLeafGroup(node, entries) {
    const group = document.createElement('div')
    group.dataset.tag = node.tag
    const rows = entries.length > 0 ? entries : [{ text: '', attrs: {} }]
    for (const entry of rows) group.appendChild(this.#renderLeafRow(node, entry))
    if (node.repeatable) {
      const addBtn = document.createElement('sl-button')
      addBtn.textContent = `Add ${node.tag}`
      addBtn.size = 'small'
      addBtn.addEventListener('click', () => group.insertBefore(this.#renderLeafRow(node, { text: '', attrs: {} }), addBtn))
      group.appendChild(addBtn)
    }
    return group
  }

  /**
   * @param {FieldNode} node
   * @param {FieldValue} entry
   * @returns {HTMLElement}
   */
  #renderLeafRow(node, entry) {
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.gap = '0.5rem'
    row.style.marginBottom = '0.25rem'

    const input = document.createElement(entry.text.includes('\n') ? 'sl-textarea' : 'sl-input')
    input.dataset.tag = node.tag
    input.size = 'small'
    input.value = entry.text
    if (node.required) input.required = true
    if (node.description) input.setAttribute('help-text', node.description)
    row.appendChild(input)

    for (const attr of node.attributes) {
      const attrInput = document.createElement(attr.values ? 'sl-select' : 'sl-input')
      attrInput.size = 'small'
      attrInput.dataset.attr = attr.name
      if (attr.values) {
        for (const v of attr.values) {
          const opt = document.createElement('sl-option')
          opt.value = v
          opt.textContent = v
          attrInput.appendChild(opt)
        }
      }
      attrInput.value = entry.attrs[attr.name] ?? ''
      row.appendChild(attrInput)
    }

    if (node.repeatable) {
      const removeBtn = document.createElement('sl-button')
      removeBtn.textContent = '✕'
      removeBtn.size = 'small'
      removeBtn.addEventListener('click', () => row.remove())
      row.appendChild(removeBtn)
    }
    return row
  }
```

Reading values back out of that rendered markup (the inverse of
`readFieldValues()`, but against `node.el` instead of the document DOM):

```js
  /**
   * @param {FieldNode} node
   * @returns {Object<string, Array<FieldValue>>}
   */
  #collectValuesFromForm(node) {
    /** @type {Object<string, Array<FieldValue>>} */
    const values = {}
    for (const child of node.children) {
      if (child.isLeaf) {
        const rows = [...child.el.children].filter((el) => el.tagName === 'DIV')
        values[child.tag] = rows.map((row) => {
          const input = row.querySelector('sl-input, sl-textarea')
          const attrs = {}
          for (const attrEl of row.querySelectorAll('[data-attr]')) attrs[attrEl.dataset.attr] = attrEl.value
          return { text: input?.value ?? '', attrs }
        })
      } else {
        Object.assign(values, this.#collectValuesFromForm(child))
      }
    }
    return values
  }

  /**
   * Required leaves (per the core schema's cardinality) with no non-empty
   * value anywhere in the rendered form. Returns the offending inputs so
   * the caller can focus/flag them, rather than just a boolean.
   * @param {FieldNode} node
   * @returns {Array<HTMLElement>}
   */
  #findEmptyRequiredInputs(node) {
    /** @type {Array<HTMLElement>} */
    const offenders = []
    for (const child of node.children) {
      if (child.isLeaf) {
        if (!child.required) continue
        const inputs = [...child.el.querySelectorAll('sl-input, sl-textarea')]
        if (!inputs.some((el) => el.value.trim() !== '')) offenders.push(inputs[0])
      } else {
        offenders.push(...this.#findEmptyRequiredInputs(child))
      }
    }
    return offenders
  }
```

Then the Save handler, which blocks on empty required fields before mutating
anything:

```js
  async #onSave() {
    const offenders = this.#fieldTree.flatMap((root) => this.#findEmptyRequiredInputs(root))
    if (offenders.length > 0) {
      offenders[0].invalid = true
      offenders[0].focus()
      notify('Fill in all required fields before saving.', 'warning', 'exclamation-triangle')
      return
    }

    const xmlTree = this.#xmlEditorApi.getXmlTree()
    if (!xmlTree) return
    const fileDesc = xmlTree.getElementsByTagName('fileDesc')[0]
    if (!fileDesc) return // fileDesc itself is always expected to exist already; not created by this dialog
    const namespaceUri = fileDesc.namespaceURI
    for (const rootNode of this.#fieldTree) {
      const values = this.#collectValuesFromForm(rootNode)
      let scopeNode = [...fileDesc.children].find((el) => el.localName === rootNode.tag)
      const hasAnyValue = Object.values(values).some((entries) => entries.some((v) => v.text.trim() !== ''))
      if (!scopeNode) {
        if (!hasAnyValue) continue
        scopeNode = xmlTree.createElementNS(namespaceUri, rootNode.tag)
        fileDesc.appendChild(scopeNode)
      }
      applyFieldValues(rootNode.children, scopeNode, values, namespaceUri)
    }
    await this.#xmlEditorApi.updateEditorFromNode(fileDesc)
    await this.#xmlEditorApi.saveIfDirty()
    this.#dialogUi.hide()
  }
```

Add `import { notify } from '../modules/sl-utils.js'` to the plugin's imports.

Wire the Save button in `start()`:

```js
    this.#dialogUi.saveBtn.addEventListener('click', () => this.#onSave())
```

- [ ] **Step 6: Run the full JS unit suite to check no regressions**

```bash
npm run test:unit:js
```

Expected: `PASS`.

- [ ] **Step 7: Commit**

```bash
git add app/src/plugins/tei-header-editor.js app/src/modules/tei-header-form.js tests/unit/js/tei-header-form.test.js
git commit -m "$(cat <<'EOF'
Wire up teiHeader editor dialog rendering and save

Populates the dialog from the live document DOM + schema structure,
renders a recursive form (sections for non-leaf tags, inputs for
leaves, add-another for repeatable fields), and on Save mutates the
DOM directly and persists via updateEditorFromNode()/saveIfDirty() -
no new backend write endpoint.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: E2E test

**Files:**
- Create: `tests/e2e/tests/tei-header-editor.spec.js`

- [ ] **Step 1: Check an existing E2E test for the login/fixture-loading boilerplate to copy**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
sed -n '1,40p' tests/e2e/tests/document-rules.spec.js
```

Use its login + document-open helper calls as the basis for this file's setup (don't guess the helper names - copy them from what that file actually imports and calls).

- [ ] **Step 2: Write the test**

```js
import { test, expect } from '@playwright/test';
// (import whatever login/openDocument helpers Step 1 found, e.g.:)
// import { login, openTestDocument } from '../helpers/...';

test.describe('TEI Header Editor', () => {
  test('reviewer can open the dialog, edit publisher, and see it persisted after reload', async ({ page }) => {
    // login(...) / openTestDocument(...) per the helpers found in Step 1
    await page.click('[name="headerEditorBtn"]');
    await expect(page.locator('sl-dialog[name="teiHeaderEditorDialog"]')).toBeVisible();
    const publisherInput = page.locator('sl-input[data-tag="publisher"]');
    await publisherInput.fill('Test Publisher E2E');
    await page.click('[name="saveBtn"]');
    await page.waitForTimeout(500); // Shoelace dialog animation, per tests/CLAUDE.md
    await page.reload();
    // re-open the document / dialog and assert the value round-tripped
    await page.click('[name="headerEditorBtn"]');
    await expect(page.locator('sl-input[data-tag="publisher"]')).toHaveValue('Test Publisher E2E');
  });

  test('pure annotator does not see the header-editor button', async ({ page }) => {
    // login as an annotator-only user per the helpers found in Step 1
    await expect(page.locator('[name="headerEditorBtn"]')).toBeHidden();
  });
});
```

(Add a `data-tag="<tag>"` attribute to each rendered leaf input in `#renderSection` from Task 9, Step 5, if not already present — needed for this test's locators and harmless for production use.)

- [ ] **Step 3: Run the test**

```bash
node tests/e2e-runner.js tests/e2e/tests/tei-header-editor.spec.js
```

Expected: `PASS` (fix the login/helper imports per whatever Step 1 actually found if this fails on setup rather than on the feature itself).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/tests/tei-header-editor.spec.js app/src/plugins/tei-header-editor.js
git commit -m "$(cat <<'EOF'
Add E2E test for the teiHeader editor

Covers the save/reload round-trip and the pure-annotator role gate.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Full suite + documentation note

**Files:**
- Modify: `docs/development/tei-header-integrations.md` (add this feature to the overview table)

- [ ] **Step 1: Add a row to the overview table**

In `docs/development/tei-header-integrations.md`, extend the existing `## Overview` table (the one with `fileDesc/titleStmt`, etc. rows) — append a note to the existing `fileDesc/titleStmt` and `fileDesc/publicationStmt, fileDesc/sourceDesc` rows' "Written by"/"Read by" columns naming `TeiHeaderEditorPlugin` as an additional writer/reader, rather than adding a new row (these are the same elements already tracked there, now with one more writer).

- [ ] **Step 2: Run the full test suite**

```bash
cd /Users/cboulanger/Code/pdf-tei-editor
npm run test:unit
npm run test:e2e
```

Expected: all `PASS`. Fix any regressions before proceeding — per project rules, this is required before considering the work done.

- [ ] **Step 3: Commit the doc update**

```bash
git add docs/development/tei-header-integrations.md
git commit -m "$(cat <<'EOF'
Document TeiHeaderEditorPlugin in the teiHeader integrations map

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Note for whoever executes this plan

`app/src/modules/api-client-v1.js`'s own header comment and `tests/CLAUDE.md` both say it is **hand-maintained**; the root `CLAUDE.md`'s "Key Files (Frontend)" section says it is **auto-generated** from the OpenAPI schema. This plan follows the hand-maintained reality (Task 5 edits the file directly) since that's what the code and the more specific doc actually say — flag the root `CLAUDE.md` line as stale to the user/maintainer separately; fixing it is outside this plan's scope.
