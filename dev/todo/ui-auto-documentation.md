# UI Auto-Documentation Implementation Plan

## Overview

Implement a plugin that automatically links UI elements to their corresponding user documentation sections, providing contextual help via tooltips with documentation icons.

## Requirements

1. Documentation pages in `docs/user-manual/**/*.md` will contain anchor tags identifying UI elements: `<a name="ui.toolbar.xml"></a>`
2. A build step generates a JSON mapping file from UI paths to documentation URLs
3. A plugin augments the UI at startup by adding help icons to tooltips
4. Icons are clickable and open the documentation drawer to the relevant section

## Technical Components

### 1. Build Tool: Documentation Index Generator

**Script:** `bin/generate-docs-index.js`

**Purpose:** Scan markdown files and create a mapping of UI element paths to documentation locations

**Functionality:**
- Scan all files matching `docs/user-manual/**/*.md`
- Parse each file to find anchor tags with `name` attributes starting with `ui.`
- Extract the UI path from `<a name="ui.path.to.element"></a>`
- Create JSON mapping: `{ "ui.toolbar.xml": "user-manual/interface-overview.md#ui.toolbar.xml" }`
- Emit warnings for duplicate UI paths (same name in multiple locations)
- Output to: `app/docs-index.json` (for development) and bundled into production build

**Implementation pattern:**
```javascript
#!/usr/bin/env node

import { glob } from 'glob';
import { readFile, writeFile } from 'fs/promises';
import { join, relative } from 'path';

/**
 * Generates a JSON index mapping UI element paths to documentation locations
 */
async function generateDocsIndex() {
  const docsIndex = {};
  const duplicates = {};

  // Find all markdown files
  const files = await glob('docs/user-manual/**/*.md');

  for (const file of files) {
    const content = await readFile(file, 'utf-8');

    // Match anchor tags with ui.* names
    const anchorRegex = /<a\s+name=["']?(ui\.[^"'\s>]+)["']?\s*><\/a>/g;
    let match;

    while ((match = anchorRegex.exec(content)) !== null) {
      const uiPath = match[1];
      const relPath = relative('docs', file).replace(/\\/g, '/');
      const docUrl = `${relPath}#${uiPath}`;

      // Check for duplicates
      if (docsIndex[uiPath]) {
        if (!duplicates[uiPath]) {
          duplicates[uiPath] = [docsIndex[uiPath]];
        }
        duplicates[uiPath].push(docUrl);
        continue; // Skip duplicates
      }

      docsIndex[uiPath] = docUrl;
    }
  }

  // Report duplicates
  if (Object.keys(duplicates).length > 0) {
    console.warn('WARNING: Duplicate UI path definitions found:');
    for (const [path, locations] of Object.entries(duplicates)) {
      console.warn(`  ${path}:`);
      locations.forEach(loc => console.warn(`    - ${loc}`));
    }
  }

  // Write output
  await writeFile(
    'app/docs-index.json',
    JSON.stringify(docsIndex, null, 2)
  );

  console.log(`Generated docs index with ${Object.keys(docsIndex).length} entries`);
}

generateDocsIndex().catch(console.error);
```

**Integration:**
- Add to `package.json` scripts: `"build:docs-index": "node bin/generate-docs-index.js"`
- Add to build pipeline in `bin/build.js`
- Run during development watch for docs changes (optional)

### 2. Plugin: UI Documentation Links

**File:** `app/src/plugins/ui-docs.js`

**Purpose:** Augment UI elements with documentation help icons

**Dependencies:**
- `ui.js` (UI navigation system)
- `info.js` plugin API (to open documentation drawer)
- `docs-index.json` (generated mapping file)

**UI Elements:**
No new UI elements, modifies existing tooltips

**Functionality:**
1. Load `docs-index.json` at startup
2. Traverse the `ui` object recursively to find all named elements
3. For each UI path in the docs index:
   - Locate the corresponding element in the UI hierarchy
   - Check if a tooltip exists for that element or its parent
   - If tooltip exists: append a help icon to the tooltip content
   - If no tooltip: wrap the element in a new tooltip with help icon
4. Attach click handlers to help icons that call `appInfo.load(docPath)`

**Implementation pattern:**
```javascript
/**
 * Plugin that adds contextual documentation links to UI elements
 *
 * @import { ApplicationState } from '../state.js'
 */
import ui from '../ui.js';
import { logger } from '../app.js';
import { SlIcon, SlTooltip } from '../ui.js';

const plugin = {
  name: 'ui-docs',
  deps: ['info'],
  install
};

export default plugin;

/**
 * Documentation index mapping UI paths to doc URLs
 * @type {Record<string, string>}
 */
let docsIndex = {};

/**
 * Plugin installation
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`);

  // Load documentation index
  try {
    const response = await fetch('docs-index.json');
    docsIndex = await response.json();
    logger.debug(`Loaded ${Object.keys(docsIndex).length} documentation entries`);
  } catch (error) {
    logger.warn('Failed to load documentation index:', error);
    return; // Exit if index unavailable
  }

  // Process UI elements after initial load
  processUIElements();
}

/**
 * Recursively processes UI elements to add documentation links
 */
function processUIElements() {
  for (const [path, docUrl] of Object.entries(docsIndex)) {
    const element = getElementByPath(path);

    if (!element) {
      logger.debug(`UI element not found: ${path}`);
      continue;
    }

    addDocumentationIcon(element, docUrl);
  }
}

/**
 * Gets a UI element by its dot-notation path
 * @param {string} path - e.g., "ui.toolbar.xml"
 * @returns {Element|null}
 */
function getElementByPath(path) {
  const parts = path.split('.');
  let current = window.ui || ui;

  // Skip first 'ui' part
  for (let i = 1; i < parts.length; i++) {
    if (!current || !current[parts[i]]) {
      return null;
    }
    current = current[parts[i]];
  }

  return current instanceof Element ? current : null;
}

/**
 * Adds a documentation help icon to an element
 * @param {Element} element
 * @param {string} docUrl
 */
function addDocumentationIcon(element, docUrl) {
  // Check if element already has a tooltip parent
  const tooltip = findTooltipParent(element);

  if (tooltip) {
    // Add icon to existing tooltip content
    appendIconToTooltip(tooltip, docUrl);
  } else {
    // Wrap element in new tooltip with icon
    wrapInTooltipWithIcon(element, docUrl);
  }
}

/**
 * Finds the closest sl-tooltip parent
 * @param {Element} element
 * @returns {SlTooltip|null}
 */
function findTooltipParent(element) {
  let current = element.parentElement;
  while (current) {
    if (current.tagName === 'SL-TOOLTIP') {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Appends a help icon to existing tooltip content
 * @param {SlTooltip} tooltip
 * @param {string} docUrl
 */
function appendIconToTooltip(tooltip, docUrl) {
  const existingContent = tooltip.content || '';

  // Create help icon
  const icon = document.createElement('sl-icon');
  icon.name = 'question-circle';
  icon.style.marginLeft = '0.5em';
  icon.style.cursor = 'pointer';
  icon.style.color = 'var(--sl-color-primary-600)';

  icon.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    openDocumentation(docUrl);
  });

  // Update tooltip content
  const span = document.createElement('span');
  span.innerHTML = existingContent;
  span.appendChild(icon);

  tooltip.content = span.innerHTML;
}

/**
 * Wraps an element in a tooltip with help icon
 * @param {Element} element
 * @param {string} docUrl
 */
function wrapInTooltipWithIcon(element, docUrl) {
  const tooltip = document.createElement('sl-tooltip');

  // Create icon
  const icon = document.createElement('sl-icon');
  icon.name = 'question-circle';
  icon.style.cursor = 'pointer';
  icon.style.color = 'var(--sl-color-primary-600)';

  icon.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    openDocumentation(docUrl);
  });

  tooltip.content = icon.outerHTML;

  // Wrap element
  element.parentElement?.insertBefore(tooltip, element);
  tooltip.appendChild(element);
}

/**
 * Opens the documentation drawer to a specific page
 * @param {string} docUrl - Relative path with anchor
 */
function openDocumentation(docUrl) {
  // Use the info plugin API
  if (window.appInfo) {
    window.appInfo.load(docUrl);
  }
}
```

**Plugin registration:**
Add to `app/src/plugins.js`:
```javascript
import { plugin as uiDocsPlugin } from './plugins/ui-docs.js'

const plugins = [
  // ... existing plugins
  uiDocsPlugin,
  startPlugin // Keep as last
]
```

### 3. Documentation Updates

**Required changes to `docs/user-manual/*.md` files:**

Add anchor tags before sections describing UI elements:

```markdown
### File Selection

<a name="ui.toolbar.pdf"></a>
The **PDF** dropdown allows you to select which PDF document to view.

<a name="ui.toolbar.xml"></a>
The **XML file version** dropdown shows the current XML document version.
```

## Alternative Implementation Ideas

### Alternative 1: Inline Documentation Tooltips

Instead of linking to the documentation drawer, show documentation content directly in enhanced tooltips.

**Pros:**
- No navigation away from current view
- Faster access to help
- Works offline without loading docs

**Cons:**
- Limited space for detailed documentation
- Need to extract and store tooltip-sized content
- Harder to maintain consistency with main docs
- Can't show images or complex formatting

**Implementation differences:**
- Build step extracts content paragraphs following anchor tags
- Store content in JSON alongside URL
- Display content in larger, richer tooltips (using Shoelace's rich content support)

### Alternative 2: Inline Annotation System

Show help icons directly adjacent to UI elements (not in tooltips).

**Pros:**
- More visible to users
- Can be styled consistently
- Works for elements without tooltips
- Easier to implement

**Cons:**
- Takes up UI space
- May clutter interface
- Harder to position correctly for all element types
- Less discoverable (users may not know what icons mean)

**Implementation differences:**
- Insert icon as sibling element rather than modifying tooltips
- Use CSS positioning to place icon near target element
- Add to parent container with flex/grid layout

### Alternative 3: Smart Help Mode

Add a global "Help Mode" toggle that highlights documented UI elements.

**Pros:**
- Doesn't clutter normal UI
- Shows users which elements have documentation
- Can use more prominent visual indicators
- Educational for new users

**Cons:**
- Requires extra user action
- Documentation not as immediately accessible
- Need additional UI for toggle button
- More complex state management

**Implementation differences:**
- Add global help mode state
- Toggle CSS classes on documented elements
- Show overlay/highlight on hover in help mode
- Click opens documentation

### Alternative 4: Context Menu Integration

Add documentation links to browser context menu for documented elements.

**Pros:**
- No visual clutter
- Familiar interaction pattern
- Works with any element type

**Cons:**
- Not discoverable (users need to know to right-click)
- Browser compatibility issues
- Conflicts with existing context menus
- Mobile devices don't have context menus

**Implementation differences:**
- Use `contextmenu` event listeners
- Create custom context menu overlay
- Inject documentation option into menu

## Recommended Approach

**Primary implementation:** Original tooltip augmentation approach (Section 2)

**Reasoning:**
- Minimal UI impact
- Leverages existing tooltip patterns
- Discoverable (users see help icon when hovering)
- Consistent with application's documentation philosophy
- Works well with Shoelace component system

**Suggested enhancement:** Add visual indicator in help mode (hybrid of Alternative 3)
- Add subtle visual cue when hovering over documented elements
- Can be implemented as phase 2 enhancement
- Provides additional discoverability without cluttering UI

## Testing Strategy

1. **Build tool testing:**
   - Verify correct parsing of anchor tags
   - Test duplicate detection
   - Validate JSON output structure

2. **Plugin testing:**
   - Test with various UI element types (buttons, selects, inputs)
   - Test with existing tooltips vs. elements without tooltips
   - Verify click handlers open correct documentation pages
   - Test with nested UI elements

3. **Integration testing:**
   - Verify documentation opens at correct anchor
   - Test with remote and local documentation modes
   - Verify behavior when docs-index.json is missing

## Implementation Steps

1. Create `bin/generate-docs-index.js` script
2. Add build script to `package.json` and integrate with `bin/build.js`
3. Add sample anchor tags to `docs/user-manual/interface-overview.md`
4. Run build tool and verify output
5. Create `app/src/plugins/ui-docs.js`
6. Register plugin in `app/src/plugins.js`
7. Test with sample documented UI elements
8. Document the anchor tag convention for documentation writers
9. Systematically add anchor tags to all user manual pages

## Future Enhancements

- Add keyboard shortcut to toggle documentation highlighting
- Support for inline documentation tooltips (Alternative 1)
- Auto-generate documentation stubs for undocumented UI elements
- IDE integration for validating anchor tags match actual UI paths
- Analytics to track which documentation sections are most accessed
