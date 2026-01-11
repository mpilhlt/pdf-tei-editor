# Providing Help to Users

This document describes the help system in the PDF-TEI Editor, which consists of two plugins: the help plugin for displaying contextual help topics, and the info plugin for showing user documentation.

## Help Plugin

The help plugin (`app/src/plugins/help.js`) provides an interactive help widget that displays contextual help topics in a vertical menu.

### Features

- **Contextual Help Icon**: A question-mark icon appears at the bottom-right of the editor area when help topics are registered
- **Topic Menu**: Clicking the icon shows registered help topics stacked vertically above the icon
- **Plugin Integration**: Other plugins can register help topics that appear in the menu
- **Smart Visibility**: The help icon automatically hides when drawers are open to prevent z-index conflicts

### Registering Help Topics

Plugins can register help topics using the `helpPlugin` singleton exported from `app/src/app.js`:

```javascript
import { helpPlugin } from '../app.js';

async function install(state) {
  // Register a help topic
  const topicId = helpPlugin.registerTopic(
    'Topic Name',        // Display label
    'icon-name',         // Shoelace icon name
    () => {              // Callback when topic is clicked
      // Handle topic selection
      showHelpContent();
    }
  );

  // Optional: Unregister later
  helpPlugin.unregisterTopic(topicId);
}
```

### Topic Registration API

**`registerTopic(label, icon, callback)`**

Registers a help topic that appears in the help menu.

- **Parameters**:
  - `label` (string): Display name shown in the menu
  - `icon` (string): Shoelace icon name (e.g., 'book', 'gear', 'question-circle')
  - `callback` (function): Handler executed when the topic is clicked
- **Returns**: `string` - Topic ID for later removal

**`unregisterTopic(topicId)`**

Removes a previously registered help topic.

- **Parameters**:
  - `topicId` (string): ID returned from `registerTopic()`


## Info Plugin

The info plugin (`app/src/plugins/info.js`) displays the user manual from markdown files in the `docs` directory. It provides both a menu item in the toolbar and a help topic registered with the help plugin.

### Features

- **Markdown Documentation**: Renders markdown files from the `docs` directory as HTML
- **Navigation**: Back/forward/home buttons for browsing documentation
- **GitHub Integration**: Edit button links to GitHub for documentation contributions
- **Version Display**: Shows application version in the drawer
- **Link Handling**:
  - Local documentation links load in the drawer
  - External links open in new browser tabs
  - Images load from local or remote sources based on connectivity
- **Offline Support**: Falls back to local documentation when offline
- **Caching**: Optional browser caching for documentation (can be disabled for development)

### Accessing the User Manual

Users can access the documentation in three ways:

1. **Help Menu**: Click the help icon (?) and select "User Manual"
2. **Toolbar Menu**: Select "About/User Manual" from the toolbar menu
3. **Login Dialog**: Click "About" button in the login dialog

### Documentation Structure

Documentation files are stored in the `docs` directory at the repository root:

```
docs/
  index.md           # Main documentation index
  user-manual/       # User-facing documentation
  development/       # Developer documentation
  images/            # Image assets
```

### Documentation Loading

The info plugin supports two documentation sources:

1. **Local Files**: Loaded from `app/web/../../docs` (development)
2. **GitHub**: Loaded from GitHub repository (production)

The source is controlled by the `docs.from-github` configuration setting. When using GitHub docs, the plugin:

- Constructs URLs using the application version tag (e.g., `v0.1.0`)
- Checks online connectivity before attempting remote fetch
- Falls back to local files if offline
- Caches responses for faster subsequent loads

### Markdown Rendering

The info plugin uses [markdown-it](https://github.com/markdown-it/markdown-it) to render markdown to HTML:

```javascript
const options = {
  html: true,        // Allow HTML tags in markdown
  linkify: true,     // Auto-convert URLs to links
  typographer: true  // Enable typographic replacements
};
md = markdownit(options);
```

After rendering, the plugin processes the HTML to:

- Replace local documentation links with JavaScript calls to `load()`
- Prefix image paths with correct base URL (local or remote)
- Add `target="_blank"` to external links
- Remove markdown comment tags that mask Shoelace components

### Navigation History

The info plugin maintains navigation history for back/forward buttons:

```javascript
let navigationHistory = [];  // Pages visited (back stack)
let forwardHistory = [];     // Pages for forward navigation
let currentPage = 'index.md'; // Currently displayed page
```

Navigation behavior:

- **Back**: Returns to previous page in history
- **Forward**: Moves forward after using back
- **Home**: Loads `index.md` (clears forward history)
- **Link Click**: Adds to history, clears forward history

### GitHub Edit Integration

The "Edit on GitHub" button constructs URLs based on the current version:

```javascript
const githubUrl = `${githubEditBasePath}/${currentPage}`;
// Example: https://github.com/mpilhlt/pdf-tei-editor/edit/v0.1.0/docs/index.md
```

This allows users to contribute documentation improvements directly through GitHub's web interface.

### Help Topic Registration

The info plugin registers itself with the help plugin during installation:

```javascript
async function install(state) {
  // ...

  helpPlugin.registerTopic(
    'User Manual',
    'book',
    () => api.open()
  );
}
```

This creates a "User Manual" topic with a book icon that opens the info drawer when clicked.

### API Reference

**`open()`**

Opens the info drawer and loads the index page if not already loaded.

**`load(mdPath, addToHistory = true)`**

Loads and renders a markdown file from the docs directory.

- **Parameters**:
  - `mdPath` (string): Path to markdown file relative to `docs/` directory
  - `addToHistory` (boolean): Whether to add to navigation history

**`goBack()`**

Navigates to the previous page in history.

**`goForward()`**

Navigates forward after using back button.

**`goHome()`**

Loads the index page (`index.md`).

**`close()`**

Closes the info drawer.

**`setEnableCache(value)`**

Enables or disables browser caching for documentation.

- **Parameters**:
  - `value` (boolean): `true` to enable caching, `false` to disable

During development, you can disable caching to always fetch fresh content:

```javascript
window.appInfo.setEnableCache(false);
```

### Plugin Dependencies

The info plugin depends on:

- `authentication`: For user session management
- `toolbar`: For menu item placement
- `help`: For registering help topic

These dependencies ensure the plugin loads after its required components are available.
