# Target XML menu: ancestry trees only

## Change

The "Target XML" and "Compare with version" menus no longer have separate "Gold" and "Versions" groups. All versions of the selected document, including gold, are grouped by lineage (`groupVersionsByLineage` in `app/src/modules/file-data-utils.js`), and the gold version carries a medal (🥇, as in the annotation progress plugin) in the option's `prefix` slot. Lineages that contain gold are listed first.

## Details

- `file-selection.js`: one code path builds both menus from the lineage groups; gold options get `data-gold="true"`.
- `FileSelection#getOptionValues()` returns `isGold` and uses `getTextLabel()`, so labels exclude the medal. `getDefaultVersion()` returns the gold option, else the first option.
- `document-actions.js`: after deleting a version (or a version with its history), the gold version is loaded via `getDefaultVersion()`, since gold is no longer necessarily the first option.
- Opening a document without an explicit `xml` still loads its gold version (`#onChangePdfSelection`, file drawer `findMatchingGold`), unchanged.
- The medal is not shown in the closed select box, because Shoelace displays only the option's text label there; the XML editor headerbar shows the "Gold:" prefix.

## Tests

- Unit: `tests/unit/js/file-data-utils-lineage.test.js` covers gold as superseded ancestor and as current version.
- E2E: `document-actions.spec.js` ("should mark new copy as gold …") checks the menu has no group headings, marks the new gold and that `getDefaultVersion()` returns gold.
