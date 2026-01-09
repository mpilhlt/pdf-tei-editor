"""
Utility functions for backend plugins 
"""

import re
from pathlib import Path
from typing import Any


def get_plugin_config(
    config_key: str,
    env_var: str,
    default: Any = None,
    value_type: str = "string"
) -> Any:
    """
    Get plugin configuration value with env var fallback.

    Priority: config.json > environment variable > default
    Creates config key from env var if it doesn't exist.

    Args:
        config_key: Dot-notation config key (e.g., "plugin.local-sync.enabled")
        env_var: Environment variable name
        default: Default value if neither source has value
        value_type: Type for validation ("string", "boolean", "number", "array")

    Returns:
        Configuration value

    Example:
        >>> enabled = get_plugin_config(
        ...     "plugin.local-sync.enabled",
        ...     "PLUGIN_LOCAL_SYNC_ENABLED",
        ...     default=False,
        ...     value_type="boolean"
        ... )
    """
    from fastapi_app.lib.config_utils import get_config
    import os

    config = get_config()

    # Try to get from config
    value = config.get(config_key)

    if value is None:
        # Check environment variable
        env_value = os.environ.get(env_var)

        if env_value is not None:
            # Parse env value based on type
            if value_type == "boolean":
                value = env_value.lower() in ("true", "1", "yes")
            elif value_type == "number":
                value = int(env_value) if env_value.isdigit() else float(env_value)
            elif value_type == "array":
                import json
                value = json.loads(env_value)
            else:
                value = env_value

            # Create config key from env var
            config.set(config_key, value)
        else:
            # Use default
            value = default
            if value is not None:
                config.set(config_key, value)

    return value


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

  // Determine parent window (iframe uses parent, popup uses opener)
  const parentWindow = window.parent !== window ? window.parent : window.opener;

  if (!parentWindow) {{
    console.warn('SandboxClient: No parent window found');
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

      // Send command to parent (iframe or opener)
      parentWindow.postMessage({{
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


def generate_datatable_page(
    title: str,
    headers: list[str],
    rows: list[list[str]],
    table_id: str = "dataTable",
    page_length: int = 25,
    default_sort_col: int = 0,
    default_sort_dir: str = "desc",
    enable_sandbox_client: bool = True,
    custom_css: str = "",
    custom_js: str = "",
    extra_content_before_table: str = ""
) -> str:
    """
    Generate a complete HTML page with a DataTables-powered table.

    Args:
        title: Page title
        headers: List of column headers
        rows: List of rows, each row is a list of cell values (can include HTML)
        table_id: HTML ID for the table element
        page_length: Number of rows per page
        default_sort_col: Column index to sort by default
        default_sort_dir: Sort direction ("asc" or "desc")
        enable_sandbox_client: Include sandbox client script for inter-window communication
        custom_css: Additional CSS to include in <style> tag
        custom_js: Additional JavaScript to run after DataTable initialization
        extra_content_before_table: Additional HTML content to insert before the table

    Returns:
        Complete HTML document as string
    """
    # Generate table rows HTML
    rows_html = []
    for row in rows:
        cells = "".join(f"<td>{cell}</td>" for cell in row)
        rows_html.append(f"<tr>{cells}</tr>")

    # Build DataTable initialization options
    datatable_options = {
        "order": [[default_sort_col, default_sort_dir]],
        "pageLength": page_length,
        "language": {
            "search": "Search:",
            "lengthMenu": "Show _MENU_ entries",
            "info": "Showing _START_ to _END_ of _TOTAL_ entries"
        }
    }

    import json
    datatable_options_json = json.dumps(datatable_options)

    # Generate sandbox client script if requested
    sandbox_script = ""
    if enable_sandbox_client:
        sandbox_script = f"<script>{generate_sandbox_client_script()}</script>"

    # Build complete HTML
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{escape_html(title)}</title>

    {sandbox_script}

    <!-- DataTables CSS -->
    <link rel="stylesheet" href="https://cdn.datatables.net/1.13.7/css/jquery.dataTables.min.css">

    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            margin: 20px;
            background-color: #fff;
        }}
        h1 {{
            margin-bottom: 20px;
            color: #333;
        }}
        #{table_id} {{
            font-size: 0.9em;
            width: 100%;
        }}
        #{table_id} thead th {{
            background-color: #f5f5f5;
            font-weight: 600;
        }}
        #{table_id} tbody tr:nth-child(even) {{
            background-color: #f9f9f9;
        }}
        #{table_id} tbody tr:hover {{
            background-color: #f0f0f0;
        }}
        .dataTables_wrapper .dataTables_paginate .paginate_button {{
            padding: 0.3em 0.8em;
        }}
        {custom_css}
    </style>
</head>
<body>
    <h1>{escape_html(title)}</h1>

    {extra_content_before_table}

    <table id="{table_id}" class="display stripe hover">
        <thead>
            <tr>
                {''.join(f'<th>{escape_html(h)}</th>' for h in headers)}
            </tr>
        </thead>
        <tbody>
            {''.join(rows_html)}
        </tbody>
    </table>

    <!-- jQuery (required for DataTables) -->
    <script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>

    <!-- DataTables JS -->
    <script src="https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js"></script>

    <script>
        $(document).ready(function() {{
            var table = $('#{table_id}').DataTable({datatable_options_json});
            console.log('DataTable initialized');

            {custom_js}
        }});
    </script>
</body>
</html>"""

    return html
