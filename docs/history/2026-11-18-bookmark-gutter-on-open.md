# Bookmark gutter marker missing after opening a document (#823)

## Problem

Opening a bookmark of another document from the Bookmarks dialog selected the element, but no bookmark icon was shown in the gutter. The same happened whenever a document with bookmarks was loaded.

## Cause

The bookmarks plugin loaded the document's bookmarks only in the XML editor's `editorAfterLoad` handler. During a load, `services.load()` sets `state.xml` to null and sets the new id only after the editor has loaded the document, so the handler saw no open document and cleared the bookmarks. Nothing loaded them again once `state.xml` was set; they only appeared after a bookmark was added, renamed or deleted.

## Fix

`BookmarksPlugin.onXmlChange()` loads the bookmarks of the document when `state.xml` changes. The `editorAfterLoad` handler still resets the tracked positions.

## Test

`tests/e2e/tests/bookmarks.spec.js` loads another document, opens the bookmark from the dialog and expects the gutter marker. It fails without the fix.
