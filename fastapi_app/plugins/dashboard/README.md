# Dashboard Plugin

Shows a two-column dashboard in a dialog after login, once per login session (reloading the page does not show it again). Other plugins contribute boxes to it; the dashboard opens only if at least one box is contributed. An info button in the toolbar, between the file drawer and the search button, reopens it.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `plugin.dashboard.show-on-login` | `true` | Open the dashboard automatically after login. Users can also turn this off with the "Show on login" checkbox (stored per browser). |

## Contributing a box

Implement the `dashboard.contributions` extension point in a frontend extension. The handler may be async and returns an array of contributions, or an empty array if there is nothing to show:

```javascript
static extensionPoints = ['dashboard.contributions'];

async ['dashboard.contributions']() {
  const dashboard = this.getDependency('dashboard');
  return [{
    id: 'my-box',               // used for the box's data-test-id
    title: 'My box',
    icon: 'star',               // optional Shoelace icon name
    element: myElement,         // HTMLElement; scrolls if it overflows the box
    cols: 1,                    // 1 or 2 columns
    rows: 2,                    // grid rows
    priority: 10,               // higher priorities are placed first
    action: {                   // optional link at the right end of the title bar
      label: 'See all',
      onClick: () => showAll()
    }
  }];
}
```

Boxes are placed in priority order into the shorter column. Before a two-column box, and at the end, the columns are levelled so that no cell stays empty: a later one-column box that exactly fits the gap is moved forward, otherwise the last box of the shorter column is stretched. Priority is therefore a strong hint, not a strict order (see `packDashboard` in [extensions/dashboard.js](extensions/dashboard.js)).

The dashboard extension also offers helpers to contributing extensions via `getDependency('dashboard')`:

- `renderDocumentList(groups)` renders grouped document rows in the common style: the document (PDF) label as plain text, the TEI label as the link that opens the document, then optional detail, status and time.
- `openDocument(xml, pdf, collection)` closes the dashboard and loads a document.
- `close()` closes the dashboard.

Backend routes of contributing plugins can use `DocumentInfoResolver` and `project_includes` from [documents.py](documents.py).

A plugin whose only purpose is a dashboard box should declare `"dependencies": ["dashboard"]`. A plugin that has other functions should not, because disabling the dashboard would then deactivate it; its contribution is simply not requested while the dashboard is inactive.

## Contributing plugins

- [recent_documents](../recent_documents/README.md): documents the user edited last, per project
- [review_queue](../review_queue/README.md): documents waiting for review
- [annotation_progress](../annotation_progress/README.md): progress per project
- [edit_history](../edit_history/README.md): recent edits in all accessible projects, with a "See all" link
