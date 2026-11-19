# Page navigation by milestones

Christian, 2026-11-19: in `grobid.training.segmentation` documents, focus mode and the **LLM Review** button of focus mode should work on pages, not on single zones.

## Decision

Pages are the ranges between the `<pb/>` elements that the GROBID extractor inserts (issue #860). No XPath selects such a range, so the navigation treats milestones specially instead of introducing a pseudo-XPath. The `xpath` state stays a valid XPath (`//tei:text//tei:pb[n]`), so the other consumers of the state keep working.

## Rules

- A milestone is an empty TEI milestone element: `pb`, `cb`, `gb`, `lb` or `milestone` (`isMilestone()` in `navigation-xpath-utils.js`).
- `XMLEditor.getNodeRange(node)`: for a milestone, from its start to the next element of the same name in document order, else to the end of the top-level element that holds it (`<text>`), without trailing whitespace. Trimming matters for zone documents: the whitespace before the next `<pb/>` belongs to the next page's first line. Other nodes keep their syntax node range.
- `XMLEditor.getRangeByXpath(xpath)` resolves a navigation xpath (`path[n]` = n-th of all, via `navigationNodeXpath()`) to that range.
- Focus mode and selection use the range; after focusing a milestone, the cursor is placed after it.
- Moving the cursor selects the last milestone at or before it. Switching the dropdown to a milestone expression selects the milestone whose range holds the current node (`indexAtOrAfterNode()`).
- The LLM Reviewer (pte-plugins annotation-review) sends the range as the scope. Its zone review already reviews the pages a scope lies on, so a page scope reviews exactly that page.
- The GROBID plugin adds the navigation entry `//tei:text//tei:pb` ("Page (`<pb>`)") as the first entry of segmentation documents.

## Not done

- Scrolling the PDF to the page of the navigated `<pb n>`.
