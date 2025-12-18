# Sandbox Control for XML Editor - Implementation Plan

## Overview

Enable plugin-generated pages (like diff viewer) to control the main application's XML editor through inter-window communication via the plugin sandbox.

Use case: Allow clicking on diff rows in the IAA plugin's diff viewer to open documents at specific line positions in the main app.

## Technical Requirements

### 1. XML Editor API Extensions

**File:** `app/src/plugins/xmleditor.js`

Add methods to XMLEditor API for line navigation:

```javascript
/**
 * Scroll to a specific line in the editor
 * @param {number} lineNumber - Line number (1-based)
 * @param {number} [column] - Optional column position (0-based)
 */
scrollToLine(lineNumber, column = 0) {
  if (!this.editorView) {
    throw new Error('Editor not initialized');
  }

  // Convert 1-based line to CodeMirror position
  const doc = this.editorView.state.doc;
  const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)));
  const pos = line.from + Math.min(column, line.length);

  // Dispatch effects to position cursor and scroll
  this.editorView.dispatch({
    selection: { anchor: pos, head: pos },
    scrollIntoView: true,
    effects: EditorView.scrollIntoView(pos, { y: 'center' })
  });

  // Focus editor
  this.editorView.focus();
}

/**
 * Open document and scroll to line
 * @param {string} stableId - Document stable ID
 * @param {number} lineNumber - Line number (1-based)
 * @param {number} [column] - Optional column position (0-based)
 */
async openDocumentAtLine(stableId, lineNumber, column = 0) {
  // Load document first
  await this.dispatchStateChange({ xml: stableId });

  // Wait for editor to update (use requestAnimationFrame or mutation observer)
  await new Promise(resolve => requestAnimationFrame(resolve));

  // Scroll to line
  this.scrollToLine(lineNumber, column);
}
```

### 2. Plugin Sandbox Module

**File:** `app/src/modules/backend-plugin-sandbox.js`

Extract PluginSandbox to separate module with comprehensive JSDoc. All public methods will be dynamically exposed to child windows.

```javascript
/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from './plugin-context.js'
 */

import { SlDialog } from '../ui.js';

/**
 * Plugin Sandbox
 *
 * Provides controlled interface for plugin-generated HTML to interact with the application.
 * Available as `window.pluginSandbox` when plugin HTML content is displayed.
 */
export class PluginSandbox {
  /**
   * @param {PluginContext} context - Plugin context
   * @param {SlDialog} dialog - Result dialog element
   */
  constructor(context, dialog) {
    this.context = context;
    this.dialog = dialog;
  }

  /**
   * Update application state
   * @param {Partial<ApplicationState>} updates - State fields to update
   */
  async updateState(updates) {
    await this.context.updateState(updates);
  }

  /**
   * Close the result dialog
   */
  closeDialog() {
    this.dialog.hide();
  }

  /**
   * Open a document by updating xml state and closing dialog
   * @param {string} stableId - Document stable ID
   */
  async openDocument(stableId) {
    // Implementation...
  }

  /**
   * Open diff view between two documents
   * @param {string} stableId1 - First document stable ID
   * @param {string} stableId2 - Second document stable ID
   */
  async openDiff(stableId1, stableId2) {
    // Implementation...
  }

  // ... existing methods ...
}
```

### 3. Plugin Sandbox Extensions

Add methods for XML editor control and inter-window communication to `PluginSandbox`:

```javascript
class PluginSandbox {
  // ... existing methods ...

  /**
   * Open document in XML editor and scroll to line
   * @param {string} stableId - Document stable ID
   * @param {number} lineNumber - Line number (1-based)
   * @param {number} [column] - Optional column position (0-based)
   */
  async openDocumentAtLine(stableId, lineNumber, column = 0) {
    const xmlEditor = XmlEditorPlugin.getInstance();
    if (!xmlEditor) {
      throw new Error('XML editor plugin not available');
    }

    await xmlEditor.openDocumentAtLine(stableId, lineNumber, column);
    this.closeDialog();
  }

  /**
   * Open URL in new window with sandbox control capability
   * @param {string} url - URL to open
   * @param {string} [name] - Window name
   * @param {string} [features] - Window features
   * @returns {Window} Opened window reference
   */
  openControlledWindow(url, name = '_blank', features = '') {
    const win = window.open(url, name, features);

    if (!win) {
      throw new Error('Failed to open window - popup blocked?');
    }

    // Set up message listener for child window commands
    const messageHandler = async (event) => {
      // Security: verify origin if needed
      if (!event.data || event.data.type !== 'SANDBOX_COMMAND') {
        return;
      }

      const { method, args, requestId } = event.data;

      try {
        // Call sandbox method dynamically
        if (typeof this[method] !== 'function') {
          throw new Error(`Unknown or non-callable sandbox method: ${method}`);
        }

        // Prevent calling private methods (starting with _)
        if (method.startsWith('_')) {
          throw new Error(`Cannot call private method: ${method}`);
        }

        const result = await this[method](...args);

        // Send response
        win.postMessage({
          type: 'SANDBOX_RESPONSE',
          requestId,
          result
        }, '*');
      } catch (error) {
        // Send error response
        win.postMessage({
          type: 'SANDBOX_RESPONSE',
          requestId,
          error: error.message
        }, '*');
      }
    };

    window.addEventListener('message', messageHandler);

    // Clean up listener when window closes
    const checkClosed = setInterval(() => {
      if (win.closed) {
        window.removeEventListener('message', messageHandler);
        clearInterval(checkClosed);
      }
    }, 1000);

    return win;
  }
}
```

### 4. Plugin Tools Module

**File:** `fastapi_app/lib/plugin_tools.py`

Create utility functions for plugins to generate JavaScript for inter-window communication. The key feature is **dynamic method discovery** - the script reads `backend-plugin-sandbox.js` to extract all public method signatures and generates the client API automatically.

```python
"""
Utility functions for backend plugins to generate JavaScript code.
"""

import re
from pathlib import Path


def _extract_sandbox_methods() -> list[dict[str, str]]:
    """
    Extract public method signatures from PluginSandbox class.

    Reads backend-plugin-sandbox.js and parses JSDoc comments and method signatures
    to build a list of available public methods.

    Returns:
        List of dicts with 'name', 'params', and 'doc' keys

    Example return:
        [
            {
                'name': 'openDocument',
                'params': ['stableId'],
                'doc': 'Open a document by updating xml state and closing dialog'
            },
            ...
        ]
    """
    # Find the sandbox module file
    sandbox_file = Path(__file__).parent.parent.parent / 'app' / 'src' / 'modules' / 'backend-plugin-sandbox.js'

    if not sandbox_file.exists():
        # Fallback to empty list if file not found
        return []

    content = sandbox_file.read_text(encoding='utf-8')

    methods = []

    # Pattern to match JSDoc comment followed by method definition
    # Matches: /** ... */ async methodName(param1, param2) {
    pattern = r'/\*\*\s*(.*?)\s*\*/\s*(?:async\s+)?(\w+)\s*\((.*?)\)\s*\{'

    for match in re.finditer(pattern, content, re.DOTALL):
        jsdoc = match.group(1)
        method_name = match.group(2)
        params_str = match.group(3)

        # Skip constructor and private methods
        if method_name == 'constructor' or method_name.startswith('_'):
            continue

        # Extract parameter names (ignore types and defaults)
        params = []
        if params_str.strip():
            for param in params_str.split(','):
                param = param.strip()
                # Extract just the name (before = or :)
                param_name = re.split(r'[=:]', param)[0].strip()
                if param_name:
                    params.append(param_name)

        # Extract first line of JSDoc as description
        doc = ''
        for line in jsdoc.split('\n'):
            line = line.strip().lstrip('*').strip()
            # Skip @param, @returns, etc.
            if line and not line.startswith('@'):
                doc = line
                break

        methods.append({
            'name': method_name,
            'params': params,
            'doc': doc
        })

    return methods


def generate_sandbox_client_script() -> str:
    """
    Generate JavaScript code that establishes connection with parent window
    and provides sandbox API access.

    Dynamically generates client methods based on PluginSandbox class definition.

    Returns:
        JavaScript code as string to be embedded in <script> tag

    Usage:
        In plugin route handler:

        from fastapi_app.lib.plugin_tools import generate_sandbox_client_script

        html = f'''
        <html>
        <head>
            <script>{generate_sandbox_client_script()}</script>
        </head>
        <body>
            <button onclick="sandbox.openDocumentAtLine('abc123', 42)">
                Open at line 42
            </button>
        </body>
        </html>
        '''
    """
    # Extract available methods
    methods = _extract_sandbox_methods()

    # Generate method wrappers
    method_code = []
    for method in methods:
        params_str = ', '.join(method['params'])
        method_code.append(f"""
    /**
     * {method['doc']}
     * @param {{{', '.join(f'{p}' for p in method['params'])}}}
     */
    {method['name']}({params_str}) {{
      return callSandboxMethod('{method['name']}', {params_str});
    }}""")

    methods_js = ',\n'.join(method_code)

    return f"""
// Sandbox client for inter-window communication
// Auto-generated from PluginSandbox class definition
(function() {{
  'use strict';

  // Check if we're in a child window
  if (!window.opener) {
    console.warn('SandboxClient: No opener window found');
    return;
  }

  let requestId = 0;
  const pendingRequests = new Map();

  // Listen for responses from parent
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'SANDBOX_RESPONSE') {
      return;
    }

    const { requestId: respId, result, error } = event.data;
    const pending = pendingRequests.get(respId);

    if (!pending) return;

    pendingRequests.delete(respId);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  });

  /**
   * Call sandbox method in parent window
   * @param {string} method - Sandbox method name
   * @param {...any} args - Method arguments
   * @returns {Promise<any>} Method result
   */
  function callSandboxMethod(method, ...args) {
    return new Promise((resolve, reject) => {
      const reqId = requestId++;

      pendingRequests.set(reqId, { resolve, reject });

      // Send command to parent
      window.opener.postMessage({
        type: 'SANDBOX_COMMAND',
        method,
        args,
        requestId: reqId
      }, '*');

      // Timeout after 10 seconds
      setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 10000);
    });
  }

  // Expose sandbox API with dynamically generated methods
  window.sandbox = {{{methods_js}
  }};

  console.log('SandboxClient: Connected to parent window');
}})();
""".strip()


def wrap_html_with_sandbox_client(html_content: str) -> str:
    """
    Wrap HTML content with sandbox client script.

    Args:
        html_content: HTML content (can be partial or complete document)

    Returns:
        Complete HTML document with sandbox client script
    """
    script = generate_sandbox_client_script()

    # If already complete document, inject script into head
    if '<html' in html_content.lower():
        # Insert before closing </head> or after <head>
        if '</head>' in html_content:
            return html_content.replace('</head>', f'<script>{script}</script>\n</head>', 1)
        elif '<head>' in html_content:
            return html_content.replace('<head>', f'<head>\n<script>{script}</script>', 1)
        else:
            # No head tag, add it
            return html_content.replace('<html', f'<html>\n<head><script>{script}</script></head>', 1)
    else:
        # Partial HTML, wrap it
        return f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <script>{script}</script>
</head>
<body>
{html_content}
</body>
</html>"""


def escape_html(text: str) -> str:
    """
    Escape HTML special characters.

    Args:
        text: Text to escape

    Returns:
        Escaped text safe for HTML insertion
    """
    if not text:
        return ""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )
```

### 4. Update Diff Viewer Route

**File:** `fastapi_app/plugins/iaa_analyzer/routes.py`

Modify `show_diff()` to use plugin tools and add clickable rows:

```python
from fastapi_app.lib.plugin_tools import generate_sandbox_client_script

def _generate_diff_html(title1: str, title2: str, xml1: str, xml2: str,
                        stable_id1: str, stable_id2: str) -> str:
    """Generate standalone HTML page with side-by-side XML diff showing only differences."""

    # Escape XML for embedding in JavaScript
    xml1_escaped = json.dumps(xml1)
    xml2_escaped = json.dumps(xml2)

    # Get sandbox client script
    sandbox_script = generate_sandbox_client_script()

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XML Diff: {_escape_html(title1)} vs {_escape_html(title2)}</title>

    <!-- Sandbox client for parent window communication -->
    <script>{sandbox_script}</script>

    <!-- Load diff library from CDN -->
    <script src="https://cdn.jsdelivr.net/npm/diff@5.2.0/dist/diff.min.js"></script>

    <!-- Load Prism.js for syntax highlighting -->
    <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-markup.min.js"></script>

    <style>
        /* ... existing styles ... */

        /* Make diff lines clickable */
        .diff-line {{
            display: flex;
            cursor: pointer;
            transition: background-color 0.15s;
        }}

        .diff-line:hover {{
            background-color: rgba(0, 0, 0, 0.05) !important;
        }}

        .diff-line:active {{
            background-color: rgba(0, 0, 0, 0.1) !important;
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>TEI XML Comparison - Differences Only</h1>
        <div class="titles">
            <span>{_escape_html(title1)}</span>
            <span>{_escape_html(title2)}</span>
        </div>
        <div class="summary" id="summary"></div>
    </div>

    <div id="diffResults"></div>

    <script>
        // XML content
        const xml1 = {xml1_escaped};
        const xml2 = {xml2_escaped};
        const stableId1 = {json.dumps(stable_id1)};
        const stableId2 = {json.dumps(stable_id2)};

        // ... existing diff rendering code ...

        // Add click handlers to diff lines
        function addClickHandler(lineDiv, stableId, lineNumber) {{
            lineDiv.addEventListener('click', async () => {{
                if (!window.sandbox) {{
                    alert('Sandbox API not available - open this page via plugin');
                    return;
                }}

                try {{
                    await window.sandbox.openDocumentAtLine(stableId, lineNumber, 0);
                }} catch (error) {{
                    console.error('Failed to open document:', error);
                    alert('Failed to open document: ' + error.message);
                }}
            }});

            // Add title attribute for hint
            lineDiv.title = 'Click to open document at line ' + lineNumber;
        }}

        // Modify diff rendering to add click handlers
        function renderDiffBlocks(diffBlocks) {{
            const resultsContainer = document.getElementById('diffResults');
            diffBlocks.forEach((block, idx) => {{
                const blockDiv = document.createElement('div');
                blockDiv.className = 'diff-block';

                // ... header ...

                // Left pane with click handlers
                const leftPane = document.createElement('div');
                leftPane.className = 'diff-pane';
                block.left.forEach(item => {{
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${{item.number}}</span><span class="line-content">${{cropLine(item.content, true)}}</span>`;

                    // Add click handler
                    addClickHandler(lineDiv, stableId1, item.number);

                    leftPane.appendChild(lineDiv);
                }});

                // Right pane with click handlers
                const rightPane = document.createElement('div');
                rightPane.className = 'diff-pane';
                block.right.forEach(item => {{
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${{item.number}}</span><span class="line-content">${{cropLine(item.content, true)}}</span>`;

                    // Add click handler
                    addClickHandler(lineDiv, stableId2, item.number);

                    rightPane.appendChild(lineDiv);
                }});

                // ... append panes ...
            }});
        }}

        // ... rest of existing code ...
    </script>
</body>
</html>
    """


@router.get("/diff")
async def show_diff(
    stable_id1: str = Query(..., description="First document stable ID"),
    stable_id2: str = Query(..., description="Second document stable ID"),
    # ... existing parameters ...
):
    """Render standalone side-by-side XML diff page showing only differences."""

    # ... existing authentication and file loading ...

    # Pass stable IDs to diff HTML generator
    html = _generate_diff_html(title1, title2, text1_xml, text2_xml, stable_id1, stable_id2)

    return Response(content=html, media_type="text/html")
```

### 5. Update IAA Plugin Table

**File:** `fastapi_app/plugins/iaa_analyzer/plugin.py`

Modify `_generate_html_table()` to use `openControlledWindow()`:

```python
def _generate_html_table(self, comparisons: list[dict[str, Any]], session_id: str) -> str:
    """Generate HTML table from comparison results."""

    # ... existing table header ...

    for comp in comparisons:
        v1 = comp['version1']
        v2 = comp['version2']

        # Create diff URL
        diff_url = f'/api/plugins/iaa-analyzer/diff?stable_id1={v1["stable_id"]}&stable_id2={v2["stable_id"]}&session_id={session_id}'

        # Use onclick with sandbox.openControlledWindow()
        view_diff_link = f'''<a href="#" onclick="event.preventDefault(); window.pluginSandbox?.openControlledWindow('{diff_url}'); return false;" style="color: #0066cc; text-decoration: underline;">View Diff</a>'''

        # ... rest of row generation ...
```

## Implementation Steps

1. **Phase 1: Extract PluginSandbox to Separate Module**
   - Create `app/src/modules/backend-plugin-sandbox.js`
   - Move `PluginSandbox` class from `backend-plugins.js` to new module
   - Export class with JSDoc comments for all public methods
   - Import and use in `backend-plugins.js`
   - Update imports and ensure no functionality breaks

2. **Phase 2: XML Editor API**
   - Add `scrollToLine()` method to XmlEditorPlugin
   - Add `openDocumentAtLine()` method
   - Test scrolling works correctly with 1-based line numbers

3. **Phase 3: Plugin Sandbox Extensions**
   - Add `openDocumentAtLine()` to PluginSandbox
   - Add `openControlledWindow()` with message handling
   - Test message passing between windows

4. **Phase 4: Plugin Tools Module with Dynamic Method Discovery**
   - Create `fastapi_app/lib/plugin_tools.py`
   - Implement method to read `backend-plugin-sandbox.js` and extract public method signatures
   - Implement `generate_sandbox_client_script()` that dynamically generates client API
   - Implement `wrap_html_with_sandbox_client()`
   - Add utility `escape_html()` function

5. **Phase 5: Diff Viewer Integration**
   - Update `_generate_diff_html()` to include sandbox client script
   - Add click handlers to diff lines
   - Pass stable IDs to template
   - Test clicking rows opens correct document at line

6. **Phase 6: IAA Table Update**
   - Update `_generate_html_table()` to use `openControlledWindow()`
   - Test diff viewer opens in new window with control capability

7. **Phase 7: Documentation**
   - Document plugin tools module
   - Document sandbox API extensions
   - Add examples to plugin development guide

## Testing

**Manual Testing:**

1. Open IAA analysis results
2. Click "View Diff" link - should open in new window
3. Click on any diff line in left pane
4. Verify document 1 opens at clicked line in main window
5. Click on any diff line in right pane
6. Verify document 2 opens at clicked line in main window
7. Test with lines at beginning, middle, and end of document

**Edge Cases:**

- Window blocked by popup blocker
- Parent window closed before child
- Invalid stable IDs
- Line numbers beyond document length
- Documents not accessible to user

## Security Considerations

- Use `postMessage()` with origin validation if needed
- Sanitize all HTML output via `escape_html()`
- Verify user has access to documents before navigation
- Timeout pending requests after 10 seconds
- Clean up event listeners when windows close

## Documentation Updates

**File:** `docs/code-assistant/plugin-development.md`

Add new section after "Interactive HTML Content":

### Inter-Window Communication

Backend plugins can generate pages that control the main application window using the sandbox client.

**Pattern:**

```python
from fastapi_app.lib.plugin_tools import generate_sandbox_client_script

def generate_controlled_page():
    script = generate_sandbox_client_script()

    return f"""<!DOCTYPE html>
    <html>
    <head>
        <script>{script}</script>
    </head>
    <body>
        <button onclick="sandbox.openDocumentAtLine('abc123', 42)">
            Open at line 42
        </button>
    </body>
    </html>"""
```

**Available Sandbox Methods in Child Window:**

Child windows can call any public method from the PluginSandbox class. Common methods include:

- `sandbox.openDocumentAtLine(stableId, lineNumber, column)` - Open document and scroll to line
- `sandbox.openDocument(stableId)` - Open document
- `sandbox.updateState(updates)` - Update application state
- `sandbox.closeDialog()` - Close result dialog
- `sandbox.openDiff(stableId1, stableId2)` - Open diff view

**Note:** Only public methods (not starting with `_`) are accessible. The client dynamically calls methods on the parent's PluginSandbox instance.

**Opening Controlled Windows from Main App:**

```javascript
// In plugin result HTML
const url = '/api/plugins/my-plugin/detail';
window.pluginSandbox?.openControlledWindow(url);
```

**Security:**

- Child windows can call any public PluginSandbox method (not starting with `_`)
- Method existence and type are validated before execution
- Private methods (prefixed with `_`) are blocked
- Requests timeout after 10 seconds
- Event listeners are cleaned up when windows close
- Origin validation can be added if needed

## Success Criteria

- Clicking diff line opens correct document at exact line in main window
- Line numbers are accurate (1-based in UI, 0-based in CodeMirror)
- Cursor is centered in viewport
- Works for both left and right panes
- Error handling for closed windows, blocked popups
- No memory leaks from unclosed listeners
- Documentation includes working examples

## Known Limitations

- Popup blockers may prevent window opening
- Browser security policies may limit postMessage() in some contexts
- Line positioning assumes pretty-printed XML format matches original

## Future Enhancements

- Highlight opened line temporarily
- Support for multiple simultaneous controlled windows
- Bi-directional state sync between windows
- Column-level positioning for precise cursor placement
- Scroll animation for better UX

## Implementation Summary

**Inter-window sandbox communication system for controlling XML editor from plugin-generated pages:**

**Architecture:**

- `PluginSandbox` extracted to `app/src/modules/backend-plugin-sandbox.js` for reusability
- XML editor extended with `scrollToLine()` and `openDocumentAtLine()` methods
- `PluginSandbox.openControlledWindow()` manages postMessage-based communication
- `fastapi_app/lib/plugin_tools.py` provides `generate_sandbox_client_script()` that dynamically generates client API by parsing sandbox module

**Key Features:**

- Dynamic method discovery - client API auto-generated from `PluginSandbox` class definition
- Security through method validation (blocks private methods, validates existence)
- Promise-based async API with request/response matching via IDs
- Automatic cleanup of event listeners when windows close
- Clickable diff rows that open documents at specific lines in parent window

**Technical Pattern:**

- Child windows include auto-generated sandbox client script
- Client calls `window.sandbox.methodName(args)` which sends `SANDBOX_COMMAND` message
- Parent validates method, executes on `PluginSandbox` instance, returns result via `SANDBOX_RESPONSE`
- All public sandbox methods automatically available without code changes

## Implementation Progress

### Phase 1: Extract PluginSandbox to Separate Module (COMPLETED)

- Created [app/src/modules/backend-plugin-sandbox.js](app/src/modules/backend-plugin-sandbox.js) with PluginSandbox class
- Moved PluginSandbox class from [app/src/plugins/backend-plugins.js:27-71](app/src/plugins/backend-plugins.js#L27-L71) to new module
- Updated backend-plugins.js to import PluginSandbox from new module [app/src/plugins/backend-plugins.js:11](app/src/plugins/backend-plugins.js#L11)
- All existing functionality preserved

### Phase 2: Add XML Editor API Methods (COMPLETED)

- Added `scrollToLine(lineNumber, column)` method to XMLEditor class [app/src/modules/xmleditor.js:432-456](app/src/modules/xmleditor.js#L432-L456)
- Added `openDocumentAtLine(stableId, lineNumber, column)` function to xmleditor plugin [app/src/plugins/xmleditor.js:453-468](app/src/plugins/xmleditor.js#L453-L468)
- Exported openDocumentAtLine for use by other modules [app/src/plugins/xmleditor.js:95](app/src/plugins/xmleditor.js#L95)

### Phase 3: Add Plugin Sandbox Extensions (COMPLETED)

- Added `openDocumentAtLine(stableId, lineNumber, column)` method to PluginSandbox [app/src/modules/backend-plugin-sandbox.js:68-77](app/src/modules/backend-plugin-sandbox.js#L68-L77)
- Added `openControlledWindow(url, name, features)` method with message handling [app/src/modules/backend-plugin-sandbox.js:79-142](app/src/modules/backend-plugin-sandbox.js#L79-L142)
- Implemented inter-window communication via postMessage with SANDBOX_COMMAND/SANDBOX_RESPONSE protocol
- Added automatic cleanup of event listeners when child windows close

### Phase 4: Create Plugin Tools Module with Dynamic Method Discovery (COMPLETED)

- Created [fastapi_app/lib/plugin_tools.py](fastapi_app/lib/plugin_tools.py) with utilities for backend plugins
- Implemented `_extract_sandbox_methods()` to dynamically parse PluginSandbox class and extract public method signatures
- Implemented `generate_sandbox_client_script()` that generates JavaScript client API by reading backend-plugin-sandbox.js
- Implemented `wrap_html_with_sandbox_client()` to inject sandbox client into HTML documents
- Implemented `escape_html()` utility function for safe HTML embedding

### Phase 5: Update Diff Viewer Integration (COMPLETED)

- Updated `_generate_diff_html()` signature to accept stable_id1 and stable_id2 parameters [fastapi_app/plugins/iaa_analyzer/routes.py:242](fastapi_app/plugins/iaa_analyzer/routes.py#L242)
- Added sandbox client script injection in HTML head [fastapi_app/plugins/iaa_analyzer/routes.py:260-261](fastapi_app/plugins/iaa_analyzer/routes.py#L260-L261)
- Added stable IDs to JavaScript constants [fastapi_app/plugins/iaa_analyzer/routes.py:454-455](fastapi_app/plugins/iaa_analyzer/routes.py#L454-L455)
- Added clickable styles to diff lines (hover and active states) [fastapi_app/plugins/iaa_analyzer/routes.py:350-362](fastapi_app/plugins/iaa_analyzer/routes.py#L350-L362)
- Implemented `addClickHandler()` function for line click handling [fastapi_app/plugins/iaa_analyzer/routes.py:484-502](fastapi_app/plugins/iaa_analyzer/routes.py#L484-L502)
- Added click handlers to left and right pane diff lines [fastapi_app/plugins/iaa_analyzer/routes.py:602-603,617-618](fastapi_app/plugins/iaa_analyzer/routes.py#L602-L603)
- Updated show_diff endpoint to pass stable IDs to \_generate_diff_html [fastapi_app/plugins/iaa_analyzer/routes.py:769](fastapi_app/plugins/iaa_analyzer/routes.py#L769)

### Phase 6: Update IAA Table (COMPLETED)

- Updated "View Diff" link to use `openControlledWindow()` instead of target="_blank" [fastapi_app/plugins/iaa_analyzer/plugin.py:428](fastapi_app/plugins/iaa_analyzer/plugin.py#L428)
- Used optional chaining (`?.`) to safely handle cases where pluginSandbox might not be available

## Final Implementation Summary

All phases completed successfully. The implementation enables plugin-generated pages (like the diff viewer) to control the main application's XML editor through inter-window communication via the plugin sandbox.

Key features implemented:

1. **Modular Architecture**: PluginSandbox extracted to separate module for reusability
2. **XML Editor Navigation**: Added `scrollToLine()` and `openDocumentAtLine()` methods for precise document positioning
3. **Inter-Window Communication**: Implemented `openControlledWindow()` with bidirectional postMessage protocol
4. **Dynamic Method Discovery**: Python utilities automatically generate client API by parsing JavaScript source
5. **Clickable Diff Viewer**: Diff rows now open documents at specific lines in the main window
6. **Security**: Method validation, private method blocking, request timeouts, and automatic cleanup

The system allows clicking on any line in the diff viewer to open the corresponding document at that exact line in the main application window, with the cursor centered in the viewport.
