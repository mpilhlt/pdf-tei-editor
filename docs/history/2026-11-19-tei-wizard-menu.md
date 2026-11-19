# TEI Wizard as a menu, per-variant enhancements, Pretty Print by review units

Issue #819. Spec: [issue comment](https://github.com/mpilhlt/pdf-tei-editor/issues/819#issuecomment-7008445895).

## Decisions (Christian, 2026-11-19)

1. Fix Common Extraction Issues, Convert XML comments (core) and Split `<bibl>` on semicolon, Segment along footnote numbers, Desegment footnotes in `<listBibl>` (GROBID plugin, mpilhlt/pte-plugins) are deleted: the LLM review fixes these problems.
2. The pipeline editor (two panes to combine and order enhancements) is deferred until there are enhancements that need to be combined.
3. Pretty Print in `<text>`: the review units of the variant are enough, no per-variant configuration.
4. Pretty Print in the `teiHeader`: the content of `desc` and of every element with mixed content is not reformatted.
5. Menu items run at once; the result is shown in the merge view.

## Implementation

- `fastapi_app/plugins/tei_wizard/routes.py`: the optional exports `variants` and `appliesTo` of an enhancement are passed into its registration.
- `fastapi_app/plugins/tei_wizard/extensions/tei-wizard.js`: the dialog with checkboxes is replaced by a dropdown like the XSL viewer's. It lists the enhancements whose `variants` match the document's variant (`variantMatches()`) and whose `appliesTo` test passes (`stylesheetAppliesTo()`), both from `app/src/modules/xsl-applicability.js`, which is now a registered module. Enhancements get an `EnhancementEnv` (`variant`, `unitPath`, `findUnits(doc)`) as fourth argument.
- `app/src/modules/unit-review.js`: `findUnitElements(xmlDoc, unitPath)`, the DOM counterpart of `findUnits()`. `UnitReviewPlugin` exposes `getVariant()`, `getUnitPath()` (the path configured by the extractors for the variant) and `findUnitElements()`.
- `fastapi_app/plugins/tei_wizard/enhancements/pretty-print-xml.js`: review units are kept (content unchanged) and placed on their own lines, their ancestors are indented. In the `teiHeader`, the elements of `tei.pretty-print.header-keep` (default `desc`) and elements with mixed content are kept. Whitespace-only text nodes inside kept elements are not removed.
- `app/src/modules/xml-utils.js`: the header formatter that runs when the header is changed (saving a revision, header editor, document people) keeps `desc` and mixed content in the same way, since it would otherwise reformat the same elements on every save.

## Tests

- `fastapi_app/plugins/tei_wizard/tests/test_tei_wizard_routes.py`: the registration of the optional exports (executed in Node).
- `fastapi_app/plugins/tei_wizard/tests/pretty-print-xml.test.js`: units, header rules.
- `tests/unit/js/unit-review.test.js` (`findUnitElements`), `tests/unit/js/xsl-applicability.test.js` (`variantMatches`), `tests/unit/js/xml-utils.test.js` (header formatter).
- `tests/e2e/tests/tei-wizard.spec.js`: menu contents, Pretty Print by units with the result in the merge view.
