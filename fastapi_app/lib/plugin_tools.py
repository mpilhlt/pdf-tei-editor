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
  if (!window.opener) {{
    console.warn('SandboxClient: No opener window found');
    return;
  }}

  let requestId = 0;
  const pendingRequests = new Map();

  // Listen for responses from parent
  window.addEventListener('message', (event) => {{
    if (!event.data || event.data.type !== 'SANDBOX_RESPONSE') {{
      return;
    }}

    const {{ requestId: respId, result, error }} = event.data;
    const pending = pendingRequests.get(respId);

    if (!pending) return;

    pendingRequests.delete(respId);

    if (error) {{
      pending.reject(new Error(error));
    }} else {{
      pending.resolve(result);
    }}
  }});

  /**
   * Call sandbox method in parent window
   * @param {{string}} method - Sandbox method name
   * @param {{...any}} args - Method arguments
   * @returns {{Promise<any>}} Method result
   */
  function callSandboxMethod(method, ...args) {{
    return new Promise((resolve, reject) => {{
      const reqId = requestId++;

      pendingRequests.set(reqId, {{ resolve, reject }});

      // Send command to parent
      window.opener.postMessage({{
        type: 'SANDBOX_COMMAND',
        method,
        args,
        requestId: reqId
      }}, '*');

      // Timeout after 10 seconds
      setTimeout(() => {{
        if (pendingRequests.has(reqId)) {{
          pendingRequests.delete(reqId);
          reject(new Error(`Request timeout: ${{method}}`));
        }}
      }}, 10000);
    }});
  }}

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
