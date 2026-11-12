# Filter XSL transformations by document (#571)

## Problem

The XSL viewer menu in the XML editor toolbar listed every registered stylesheet for every TEI document, including the `biblStruct` transformations for documents without references and the archival edition view for documents of other variants.

## Solution

Registrations passed to `xsl-viewer.register()` take an optional `appliesTo` test. The menu lists only the stylesheets whose test passes for the open document, and the toolbar button is disabled when none does.

- `appliesTo` is either an XPath expression or a function `(xmlDoc) => boolean`. The XPath form is evaluated with the `tei` and `xml` prefixes bound and its result converted to a boolean, so most rules are one declarative line such as `boolean(//tei:biblStruct)`. The function form covers tests XPath cannot express. This extends the function-only design proposed in the issue.
- Without `appliesTo`, a stylesheet applies to every document whose root element is in its `xmlns`, so existing registrations keep working.
- A test that throws (invalid XPath, failing function) counts as "does not apply" and is logged as a warning.
- The check lives in `app/src/modules/xsl-applicability.js` (`stylesheetAppliesTo`), unit-tested in `tests/unit/js/xsl-applicability.test.js`.
- The button state is recomputed when a document is loaded (`editorAfterLoad`), when `state.xml` changes and after edits are synced (`editorXmlWellFormed`); the menu is rebuilt when the dropdown opens, so references added while editing show up without reloading.

## Registrations

- `xslt_export` (this repository): reference list, tabular data, CSV, RIS and CrossRef XML apply to documents containing `tei:biblStruct`, independent of the variant.
- `archival-edition` (mpilhlt/pte-plugins): the page view applies to documents whose extractor variant id is `archival-edition`.
