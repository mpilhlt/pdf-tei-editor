import os
import re
import shutil

# --- Configuration ---
SCAN_DIRECTORY = './app/src'
NODE_MODULES_PATH = './node_modules'
SHOELACE_ICONS_BASE_PATH = os.path.join(
    NODE_MODULES_PATH,
    '@shoelace-style',
    'shoelace',
    'dist',
    'assets',
    'icons'
)
DESTINATION_ICONS_DIRECTORY = './app/web/assets/icons'

# Patterns to match icon usage in different contexts:
# 1. HTML <sl-icon>: <sl-icon name="icon-name">
# 2. HTML icon attribute: <any-element icon="icon-name">
# 3. JS property assignment: something.icon = 'icon-name'
# 4. JS object literal: icon: 'icon-name'
ICON_PATTERNS = [
    re.compile(r'<sl-icon[^>]*name="([^"]+)"'),  # HTML sl-icon tags
    re.compile(r'\sicon="([^"]+)"'),  # HTML icon attribute
    re.compile(r'\.icon\s*=\s*[\'"]([^"\']+)[\'"]'),  # JS: .icon = 'name'
    re.compile(r'icon:\s*[\'"]([^"\']+)[\'"]'),  # JS: icon: 'name'
]
SCAN_EXTENSIONS = ['.js', '.html']

# --- Script Logic ---

def find_used_icons(directory, patterns, extensions):
    """
    Find all icon names used in source files.

    Args:
        directory: Directory to scan
        patterns: List of compiled regex patterns to match icon names
        extensions: File extensions to scan

    Returns:
        Set of icon names found
    """
    found_icons = set()
    print(f"Scanning: {directory}")

    if not os.path.isdir(directory):
        print(f"Error: Directory not found: {directory}")
        return found_icons

    for root, _, files in os.walk(directory):
        for file in files:
            if any(file.endswith(ext) for ext in extensions):
                filepath = os.path.join(root, file)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        content = f.read()
                        # Try all patterns
                        for pattern in patterns:
                            matches = pattern.findall(content)
                            if matches:
                                found_icons.update(matches)
                except (UnicodeDecodeError, IOError):
                    pass # Skip problematic files silently

    return found_icons

def copy_icons(icon_names, shoelace_base_path, destination_path):
    if not os.path.isdir(shoelace_base_path):
        import sys
        print(f"Error: Shoelace icons path not found: {shoelace_base_path}")
        print(f"Make sure @shoelace-style/shoelace is installed in node_modules")
        sys.exit(1)

    if not os.path.exists(destination_path):
        os.makedirs(destination_path, exist_ok=True)

    # Filter out variable placeholders like ${icon}, ${btn.name}, etc.
    filtered_icons = [name for name in icon_names if not ('${' in name or '{' in name)]
    skipped_count = len(icon_names) - len(filtered_icons)

    if skipped_count > 0:
        print(f"Skipped {skipped_count} variable placeholder(s)")

    copied_count = 0
    for icon_name in sorted(filtered_icons):
        src_icon_path = os.path.join(shoelace_base_path, f"{icon_name}.svg")
        dest_icon_path = os.path.join(destination_path, f"{icon_name}.svg")

        if os.path.exists(src_icon_path):
            try:
                shutil.copy2(src_icon_path, dest_icon_path)
                # print(f"Copied: {icon_name}.svg") # Uncomment for more verbose output
                copied_count += 1
            except IOError as e:
                print(f"Error copying {icon_name}.svg: {e}")
        else:
            print(f"Warning: Source icon not found for '{icon_name}': {src_icon_path}")

    print(f"Copied {copied_count}/{len(filtered_icons)} icons.")

# --- Main ---
if __name__ == "__main__":
    used_icons = find_used_icons(SCAN_DIRECTORY, ICON_PATTERNS, SCAN_EXTENSIONS)

    if used_icons:
        copy_icons(used_icons, SHOELACE_ICONS_BASE_PATH, DESTINATION_ICONS_DIRECTORY)
    else:
        import sys
        print(f"Error: No Shoelace icons found in {SCAN_DIRECTORY}")
        print(f"This usually indicates the source files are missing or the scan pattern is incorrect")
        sys.exit(1)