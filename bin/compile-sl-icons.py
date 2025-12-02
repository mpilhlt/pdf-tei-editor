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
ICON_PATTERN = re.compile(r'<sl-icon name="([^"]+)"')
SCAN_EXTENSIONS = ['.js', '.html']

# --- Script Logic ---

def find_used_icons(directory, pattern, extensions):
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
                        matches = pattern.findall(content)
                        if matches:
                            found_icons.update(matches)
                except (UnicodeDecodeError, IOError):
                    pass # Skip problematic files silently

    return found_icons

def copy_icons(icon_names, shoelace_base_path, destination_path):
    if not os.path.isdir(shoelace_base_path):
        print(f"Error: Shoelace icons path not found: {shoelace_base_path}")
        return

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
    used_icons = find_used_icons(SCAN_DIRECTORY, ICON_PATTERN, SCAN_EXTENSIONS)

    if used_icons:
        copy_icons(used_icons, SHOELACE_ICONS_BASE_PATH, DESTINATION_ICONS_DIRECTORY)
    else:
        print("No Shoelace icons found.")