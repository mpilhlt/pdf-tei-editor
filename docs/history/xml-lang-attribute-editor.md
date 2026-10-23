# `xml:lang` in the visual mode attribute editor

## Problem

The attribute editor of the XML editor's visual mode offered no `xml:lang` on `<title>` in the GROBID references variant, although the Fossil schema (`schema/grobid.training.references.rng`) declares it:

```xml
<optional>
  <attribute name="lang" ns="http://www.w3.org/XML/1998/namespace"/>
</optional>
```

The attribute list of a chip comes from the variant's RelaxNG schema (`fastapi_app/lib/utils/annotation_tags.py` → `RelaxNGParser.extract_tag_definitions()`). The parser read only the `name` attribute of `<attribute>` and ignored `ns`, so the attribute arrived as `lang`. The popup then showed a `lang` row and wrote a non-namespaced `lang="…"` attribute. No change in Fossil is needed.

## Changes

- `fastapi_app/lib/utils/relaxng_to_codemirror.py`: new `attribute_name()` returns the qualified name of an RNG `<attribute>`. An attribute in the XML namespace is returned as `xml:<local>`; a `<name ns="…">` child is read when there is no `name` attribute. All attribute-name lookups in the parser use it, which also fixes schema-based autocompletion.
- `app/src/modules/codemirror/xml-annotation-popup.js`: new exported `setPopupAttribute()` creates `xml:`-prefixed attributes with `setAttributeNS()` in the XML namespace, so a newly added `xml:lang` is the same attribute a parsed one would be.
- Tests: `tests/unit/fastapi/test_annotation_tags.py` (`xml:lang` via `ns` attribute and via `<name>` child), `tests/unit/js/xml-annotation-popup.test.js` (`setPopupAttribute`).

## Notes

- The editor caches downloaded schemas for up to an hour (see `SCHEMA_CACHE_TTL_SECONDS`). The chip list regenerates when the cached schema changes.
- Attributes in namespaces other than XML have no fixed prefix and keep their local name.
