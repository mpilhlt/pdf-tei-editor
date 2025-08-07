#!/usr/bin/env python3
"""
TEI Document Migration Script

This script migrates TEI documents by updating their headers and reorganizing version files.
It processes files in /data/webdav-data/**/*.tei.xml and creates a mirror directory 
structure in /data/webdav-data-migrated with the migrated files.

Usage:
    python bin/migrate.py
"""

import os
import sys
import shutil
from pathlib import Path
from lxml import etree
import datetime
import re
from glob import glob

# TEI namespace constant
TEI_NS = "http://www.tei-c.org/ns/1.0"
TEI_PREFIX = f"{{{TEI_NS}}}"


def main():
    """Main migration function"""
    # Add the server directory to Python path for imports
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    server_dir = project_root / "server"
    sys.path.insert(0, str(server_dir))
    
    # Import TEI serialization utility
    from lib.tei_utils import serialize_tei_with_formatted_header
    
    # Set up paths
    source_dir = project_root / "data" / "webdav-data"
    target_dir = project_root / "data" / "webdav-data-migrated"
    
    print(f"Migrating TEI files from {source_dir} to {target_dir}")
    
    if not source_dir.exists():
        print(f"Source directory {source_dir} does not exist!")
        return 1
    
    # Delete target directory if it exists to remove any leftovers
    if target_dir.exists():
        print(f"Removing existing target directory: {target_dir}")
        shutil.rmtree(target_dir)
    
    # Create fresh target directory
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # Copy PDF directory
    print("Copying PDF directory...")
    pdf_source = source_dir / "pdf"
    pdf_target = target_dir / "pdf"
    if pdf_source.exists():
        shutil.copytree(pdf_source, pdf_target)
        print(f"Copied PDF directory: {pdf_source} -> {pdf_target}")
    
    # Copy awagner collection as-is without migration
    print("Copying awagner collection as-is...")
    awagner_dirs = ["pdf/awagner", "tei/awagner"]
    for awagner_dir in awagner_dirs:
        awagner_source = source_dir / awagner_dir
        awagner_target = target_dir / awagner_dir
        if awagner_source.exists():
            awagner_target.parent.mkdir(parents=True, exist_ok=True)
            if awagner_target.exists():
                shutil.rmtree(awagner_target)
            shutil.copytree(awagner_source, awagner_target)
            print(f"Copied awagner collection: {awagner_source} -> {awagner_target}")
    
    # Process TEI files (exclude awagner collection)
    tei_files = []
    for tei_file in source_dir.rglob("*.tei.xml"):
        # Skip awagner collection files since they're copied as-is
        if "awagner" not in tei_file.parts:
            tei_files.append(tei_file)
    
    print(f"Found {len(tei_files)} TEI files to process (excluding awagner)")
    
    migrated_count = 0
    error_count = 0
    
    for tei_file in tei_files:
        try:
            # Calculate relative path from source
            rel_path = tei_file.relative_to(source_dir)
            target_file = target_dir / rel_path
            
            # Create target directory
            target_file.parent.mkdir(parents=True, exist_ok=True)
            
            # Migrate the TEI file
            if migrate_tei_file(tei_file, target_file):
                migrated_count += 1
                print(f"[OK] Migrated: {rel_path}")
            else:
                print(f"[SKIP] Skipped: {rel_path} (no changes needed)")
                # Copy unchanged file
                shutil.copy2(tei_file, target_file)
                
        except Exception as e:
            error_count += 1
            print(f"[ERROR] Error processing {tei_file}: {e}")
    
    # Migrate version files
    print("\nMigrating version files...")
    version_source = source_dir / "versions"
    version_target = target_dir / "versions"
    
    if version_source.exists():
        migrated_versions = migrate_version_files(version_source, version_target)
        print(f"Migrated {migrated_versions} version files")
    else:
        print("No version directory found")
    
    print(f"\nMigration completed:")
    print(f"  Migrated: {migrated_count} files")
    print(f"  Errors: {error_count} files")
    
    return 0 if error_count == 0 else 1


def migrate_tei_file(source_file: Path, target_file: Path) -> bool:
    """
    Migrate a single TEI file by updating its header structure.
    
    Args:
        source_file: Path to source TEI file
        target_file: Path to target TEI file
        
    Returns:
        True if file was migrated (changed), False if no changes needed
    """
    try:
        # Parse the XML
        tree = etree.parse(str(source_file))
        root = tree.getroot()
        
        # Check if migration is needed and perform it
        changed = False
        
        # Get file basename without .tei.xml extension for fileref
        file_id = source_file.stem
        if file_id.endswith('.tei'):
            file_id = file_id[:-4]
        
        # Check for GROBID format first
        if is_grobid_format(root):
            # Clean file_id for GROBID files that already have variant suffix
            clean_file_id = file_id
            if file_id.endswith('.grobid.training.segmentation'):
                clean_file_id = file_id[:-len('.grobid.training.segmentation')]
            
            # Update target filename for GROBID files to include variant (if not already present)
            if not file_id.endswith('.grobid.training.segmentation'):
                new_file_id = f"{clean_file_id}.grobid.training.segmentation"
                target_file = target_file.parent / f"{new_file_id}.tei.xml"
            
            migrate_grobid_header(root, clean_file_id)
            changed = True
        # Check for LLamore format or assume LLamore if no application elements
        elif is_llamore_format(root) or not has_application_elements(root):
            migrate_llamore_header(root, file_id)
            changed = True
        
        if changed:
            # Write the modified XML using appropriate serialization
            if is_llamore_format(root) or not has_application_elements(root):
                # Use RelaxNG-aware serialization for LLamore files
                from lib.tei_utils import serialize_tei_xml
                formatted_xml = serialize_tei_xml(root)
                with open(str(target_file), 'w', encoding='utf-8') as f:
                    f.write('<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + formatted_xml)
            else:
                # Use formatted header serialization for other files
                from lib.tei_utils import serialize_tei_with_formatted_header
                formatted_xml = serialize_tei_with_formatted_header(root)
                with open(str(target_file), 'w', encoding='utf-8') as f:
                    f.write('<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + formatted_xml)
            
        return changed
        
    except Exception as e:
        raise RuntimeError(f"Failed to migrate {source_file}: {e}")


def is_llamore_format(root) -> bool:
    """Check if TEI document has LLamore format header"""
    ns = {"tei": TEI_NS}
    llamore_apps = root.xpath('.//tei:application[@ident="llamore"]', namespaces=ns)
    return len(llamore_apps) > 0


def is_grobid_format(root) -> bool:
    """Check if TEI document has GROBID format header"""
    ns = {"tei": TEI_NS}
    grobid_apps = root.xpath('.//tei:application[@ident="GROBID"]', namespaces=ns)
    return len(grobid_apps) > 0


def has_application_elements(root) -> bool:
    """Check if TEI document has any application elements"""
    ns = {"tei": TEI_NS}
    apps = root.xpath('.//tei:application', namespaces=ns)
    return len(apps) > 0


def migrate_llamore_header(root, file_id: str):
    """Migrate LLamore format header to new structure"""
    ns = {"tei": TEI_NS}
    
    # Remove XSD schema validation attributes if present
    xsi_namespace = "http://www.w3.org/2001/XMLSchema-instance"
    if f"{{{xsi_namespace}}}schemaLocation" in root.attrib:
        del root.attrib[f"{{{xsi_namespace}}}schemaLocation"]
    
    # Remove xsi namespace declaration if no longer needed
    nsmap = root.nsmap.copy() if root.nsmap else {}
    if "xsi" in nsmap and nsmap["xsi"] == xsi_namespace:
        # Check if there are any other xsi attributes
        has_other_xsi = any(attr.startswith(f"{{{xsi_namespace}}}") for attr in root.attrib)
        if not has_other_xsi:
            # We need to recreate the element without xsi namespace
            # This will be handled by the serializer via the _relaxng_schema marker
            pass
    
    # Add RelaxNG schema marker for processing instruction
    root.set("_relaxng_schema", "https://tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng")
    
    # Get timestamp (use fixed timestamp from requirements)
    timestamp = "2025-08-07T15:34:03.891269Z"
    formatted_date = "07.08.2025 15:34:03"
    
    tei_header = root.find('.//tei:teiHeader', ns)
    if tei_header is None:
        return
        
    file_desc = tei_header.find('./tei:fileDesc', ns)
    if file_desc is None:
        return
        
    # Add or update editionStmt
    edition_stmt = file_desc.find('./tei:editionStmt', ns)
    if edition_stmt is None:
        # Create editionStmt after titleStmt
        title_stmt = file_desc.find('./tei:titleStmt', ns)
        if title_stmt is not None:
            edition_stmt = etree.Element(f"{TEI_PREFIX}editionStmt")
            title_stmt.addnext(edition_stmt)
        else:
            edition_stmt = etree.SubElement(file_desc, f"{TEI_PREFIX}editionStmt")
    
    # Clear existing editions and create new one
    for edition in edition_stmt.findall('./tei:edition', ns):
        edition_stmt.remove(edition)
        
    edition = etree.SubElement(edition_stmt, f"{TEI_PREFIX}edition")
    
    date_elem = etree.SubElement(edition, f"{TEI_PREFIX}date", when=timestamp)
    date_elem.text = formatted_date
    
    title_elem = etree.SubElement(edition, f"{TEI_PREFIX}title")
    title_elem.text = "LLamore reference extraction"
    
    # Add fileref if not present
    fileref_elem = edition.find('./tei:idno[@type="fileref"]', ns)
    if fileref_elem is None:
        fileref_elem = etree.SubElement(edition, f"{TEI_PREFIX}idno", type="fileref")
        fileref_elem.text = file_id
    
    # Update encodingDesc
    encoding_desc = tei_header.find('./tei:encodingDesc', ns)
    if encoding_desc is None:
        encoding_desc = etree.SubElement(tei_header, f"{TEI_PREFIX}encodingDesc")
    
    # Clear existing appInfo and create new one
    app_info = encoding_desc.find('./tei:appInfo', ns)
    if app_info is None:
        app_info = etree.SubElement(encoding_desc, f"{TEI_PREFIX}appInfo")
    else:
        app_info.clear()
    
    # Add pdf-tei-editor application
    pdf_app = etree.SubElement(app_info, f"{TEI_PREFIX}application",
                              version="1.0", ident="pdf-tei-editor", type="editor")
    pdf_label = etree.SubElement(pdf_app, f"{TEI_PREFIX}label")
    pdf_label.text = "PDF-TEI-Editor"
    etree.SubElement(pdf_app, f"{TEI_PREFIX}ref",
                    target="https://github.com/mpilhlt/pdf-tei-editor")
    
    # Add llamore application
    llamore_app = etree.SubElement(app_info, f"{TEI_PREFIX}application",
                                  version="1.0", ident="llamore", when=timestamp, type="extractor")
    
    llamore_label = etree.SubElement(llamore_app, f"{TEI_PREFIX}label")
    llamore_label.text = "A Python package to extract and evaluate scientific references and citations from free-form text and PDFs using LLM/VLMs."
    
    variant_label = etree.SubElement(llamore_app, f"{TEI_PREFIX}label", 
                                   type="variant-id")
    variant_label.text = "llamore-default"
    
    prompter_label = etree.SubElement(llamore_app, f"{TEI_PREFIX}label", 
                                    type="prompter")
    prompter_label.text = "LineByLinePrompter"
    
    etree.SubElement(llamore_app, f"{TEI_PREFIX}ref",
                    target="https://github.com/mpilhlt/llamore")


def migrate_grobid_header(root, file_id: str):
    """Migrate GROBID format header to new structure"""
    ns = {"tei": TEI_NS}
    
    # Get timestamp (use fixed timestamp from requirements)  
    timestamp = "2025-08-07T14:15:00.573667Z"
    formatted_date = "07.08.2025 14:15:00"
    
    tei_header = root.find('.//tei:teiHeader', ns)
    if tei_header is None:
        return
        
    file_desc = tei_header.find('./tei:fileDesc', ns)
    if file_desc is None:
        return
    
    # Extract existing GROBID application info
    existing_grobid = root.find('.//tei:application[@ident="GROBID"]', ns)
    grobid_version = "0.8.3-SNAPSHOT"
    grobid_desc = "GROBID - A machine learning software for extracting information from scholarly documents"
    grobid_revision = "e13aa19"
    grobid_flavor = "article/dh-law-footnotes"
    
    if existing_grobid is not None:
        grobid_version = existing_grobid.get("version", grobid_version)
        desc_elem = existing_grobid.find('./tei:desc', ns)
        if desc_elem is not None and desc_elem.text:
            grobid_desc = desc_elem.text
        
        # Extract revision from label
        revision_elem = existing_grobid.find('./tei:label[@type="revision"]', ns)
        if revision_elem is not None and revision_elem.text:
            grobid_revision = revision_elem.text
            
        # Extract flavor from parameters
        params_elem = existing_grobid.find('./tei:label[@type="parameters"]', ns)
        if params_elem is not None and params_elem.text:
            # Extract flavor from "flavor=article/dh-law-footnotes" format
            params_text = params_elem.text
            flavor_match = re.search(r'flavor=([^/]+/[^/]+)', params_text)
            if flavor_match:
                grobid_flavor = flavor_match.group(1)
    
    # Add or update editionStmt
    edition_stmt = file_desc.find('./tei:editionStmt', ns)
    if edition_stmt is None:
        # Create editionStmt after titleStmt
        title_stmt = file_desc.find('./tei:titleStmt', ns)
        if title_stmt is not None:
            edition_stmt = etree.Element(f"{TEI_PREFIX}editionStmt")
            title_stmt.addnext(edition_stmt)
        else:
            edition_stmt = etree.SubElement(file_desc, f"{TEI_PREFIX}editionStmt")
    
    # Clear existing editions and create new one
    for edition in edition_stmt.findall('./tei:edition', ns):
        edition_stmt.remove(edition)
        
    edition = etree.SubElement(edition_stmt, f"{TEI_PREFIX}edition")
    
    date_elem = etree.SubElement(edition, f"{TEI_PREFIX}date", when=timestamp)
    date_elem.text = formatted_date
    
    title_elem = etree.SubElement(edition, f"{TEI_PREFIX}title")
    title_elem.text = f"grobid.training.segmentation [{grobid_flavor}]"
    
    # Add fileref if not present
    fileref_elem = edition.find('./tei:idno[@type="fileref"]', ns)
    if fileref_elem is None:
        fileref_elem = etree.SubElement(edition, f"{TEI_PREFIX}idno", type="fileref")
        fileref_elem.text = file_id
    
    # Update encodingDesc
    encoding_desc = tei_header.find('./tei:encodingDesc', ns)
    if encoding_desc is None:
        encoding_desc = etree.SubElement(tei_header, f"{TEI_PREFIX}encodingDesc")
    
    # Clear existing appInfo and create new one
    app_info = encoding_desc.find('./tei:appInfo', ns)
    if app_info is None:
        app_info = etree.SubElement(encoding_desc, f"{TEI_PREFIX}appInfo")
    else:
        app_info.clear()
    
    # Add pdf-tei-editor application
    pdf_app = etree.SubElement(app_info, f"{TEI_PREFIX}application",
                              version="1.0", ident="pdf-tei-editor", type="editor")
    pdf_label = etree.SubElement(pdf_app, f"{TEI_PREFIX}label")
    pdf_label.text = "PDF-TEI-Editor"
    etree.SubElement(pdf_app, f"{TEI_PREFIX}ref",
                    target="https://github.com/mpilhlt/pdf-tei-editor")
    
    # Add GROBID application
    grobid_app = etree.SubElement(app_info, f"{TEI_PREFIX}application",
                                 version=grobid_version, ident="GROBID", when=timestamp, type="extractor")
    
    grobid_label = etree.SubElement(grobid_app, f"{TEI_PREFIX}label")
    grobid_label.text = "A machine learning software for extracting information from scholarly documents"
    
    desc_elem = etree.SubElement(grobid_app, f"{TEI_PREFIX}desc")
    desc_elem.text = grobid_desc
    
    revision_label = etree.SubElement(grobid_app, f"{TEI_PREFIX}label", 
                                    type="revision")
    revision_label.text = grobid_revision
    
    flavor_label = etree.SubElement(grobid_app, f"{TEI_PREFIX}label", 
                                   type="flavor")
    flavor_label.text = grobid_flavor
    
    variant_label = etree.SubElement(grobid_app, f"{TEI_PREFIX}label", 
                                   type="variant-id")
    variant_label.text = "grobid.training.segmentation"
    
    etree.SubElement(grobid_app, f"{TEI_PREFIX}ref",
                    target="https://github.com/kermitt2/grobid")


def migrate_version_files(source_dir: Path, target_dir: Path) -> int:
    """
    Migrate version files from old structure to new structure.
    
    Old: /data/webdav-data/versions/<timestamp>/<file-id>.tei.xml
    New: /data/webdav-data/versions/<file-id>/<timestamp>-<file-id>.tei.xml
    
    Only migrates old-format timestamp directories. New-format directories are 
    migrated by processing their files individually.
    
    Args:
        source_dir: Source versions directory
        target_dir: Target versions directory
        
    Returns:
        Number of files migrated
    """
    migrated_count = 0
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # Process all subdirectories - ONLY migrate old timestamp directories
    for subdir in source_dir.iterdir():
        if not subdir.is_dir():
            continue
            
        dir_name = subdir.name
        
        # Check if this is old format (timestamp-named directory)
        # Use same logic as server_utils.py: timestamp contains only digits, hyphens, underscores, spaces
        is_timestamp_dir = dir_name.replace("_", "").replace("-", "").replace(" ", "").isdigit()
        
        if is_timestamp_dir:
            # Old format: directory named with timestamp, files named with file-id
            timestamp = dir_name
            
            # Process all .tei.xml and .xml files in this timestamp directory
            for version_file in subdir.glob("*.xml"):
                # Get file_id from filename
                file_stem = version_file.stem
                file_id = file_stem
                
                # Handle .tei.xml files (remove .tei suffix from file_id if present)
                if file_stem.endswith('.tei'):
                    file_id = file_stem[:-4]
                
                # Create new directory structure: versions/<file-id>/
                new_dir = target_dir / file_id
                new_dir.mkdir(parents=True, exist_ok=True)
                
                # Determine final extension
                final_extension = ".tei.xml" if version_file.name.endswith(".tei.xml") else ".xml"
                
                # New filename format: <timestamp>-<file-id>.tei.xml (or .xml)
                new_filename = f"{timestamp}-{file_id}{final_extension}"
                new_file_path = new_dir / new_filename
                
                # Apply header migration to version files if they are TEI files
                if version_file.name.endswith('.tei.xml'):
                    try:
                        # Parse and migrate the version file
                        tree = etree.parse(str(version_file))
                        root = tree.getroot()
                        
                        # Apply the same migration logic as main files
                        changed = False
                        if is_grobid_format(root):
                            # Clean file_id for GROBID files that already have variant suffix
                            clean_file_id = file_id
                            if file_id.endswith('.grobid.training.segmentation'):
                                clean_file_id = file_id[:-len('.grobid.training.segmentation')]
                            
                            migrate_grobid_header(root, clean_file_id)
                            changed = True
                        elif is_llamore_format(root) or not has_application_elements(root):
                            migrate_llamore_header(root, file_id)
                            changed = True
                        
                        if changed:
                            # Write the migrated version file using appropriate serialization
                            if is_llamore_format(root) or not has_application_elements(root):
                                # Use RelaxNG-aware serialization for LLamore files
                                from lib.tei_utils import serialize_tei_xml
                                formatted_xml = serialize_tei_xml(root)
                                with open(str(new_file_path), 'w', encoding='utf-8') as f:
                                    f.write('<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + formatted_xml)
                            else:
                                # Use formatted header serialization for other files
                                from lib.tei_utils import serialize_tei_with_formatted_header
                                formatted_xml = serialize_tei_with_formatted_header(root)
                                with open(str(new_file_path), 'w', encoding='utf-8') as f:
                                    f.write('<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + formatted_xml)
                        else:
                            # No changes needed, just copy
                            shutil.copy2(version_file, new_file_path)
                            
                    except Exception as e:
                        print(f"  [ERROR] Failed to migrate version file {version_file}: {e}")
                        # Fallback to copying the original file
                        shutil.copy2(version_file, new_file_path)
                else:
                    # Non-TEI files, just copy
                    shutil.copy2(version_file, new_file_path)
                
                migrated_count += 1
                print(f"  [MIGRATED] {version_file.relative_to(source_dir)} -> {new_file_path.relative_to(target_dir)}")
        else:
            # New format: directory already named with file-id
            # These are already in correct structure, copy them to target
            file_id = dir_name
            new_dir = target_dir / file_id
            new_dir.mkdir(parents=True, exist_ok=True)
            
            # Process files in this directory
            for version_file in subdir.iterdir():
                if version_file.is_file() and version_file.suffix in ['.xml']:
                    new_file_path = new_dir / version_file.name
                    
                    # Apply header migration to version files if they are TEI files
                    if version_file.name.endswith('.tei.xml'):
                        try:
                            # Parse and migrate the version file
                            tree = etree.parse(str(version_file))
                            root = tree.getroot()
                            
                            # Extract file_id from the directory name (which is the file_id)
                            file_id = dir_name
                            
                            # Apply the same migration logic as main files
                            changed = False
                            if is_grobid_format(root):
                                # Clean file_id for GROBID files that already have variant suffix
                                clean_file_id = file_id
                                if file_id.endswith('.grobid.training.segmentation'):
                                    clean_file_id = file_id[:-len('.grobid.training.segmentation')]
                                
                                migrate_grobid_header(root, clean_file_id)
                                changed = True
                            elif is_llamore_format(root) or not has_application_elements(root):
                                migrate_llamore_header(root, file_id)
                                changed = True
                            
                            if changed:
                                # Write the migrated version file using appropriate serialization
                                if is_llamore_format(root) or not has_application_elements(root):
                                    # Use RelaxNG-aware serialization for LLamore files
                                    from lib.tei_utils import serialize_tei_xml
                                    formatted_xml = serialize_tei_xml(root)
                                    with open(str(new_file_path), 'w', encoding='utf-8') as f:
                                        f.write('<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + formatted_xml)
                                else:
                                    # Use formatted header serialization for other files
                                    from lib.tei_utils import serialize_tei_with_formatted_header
                                    formatted_xml = serialize_tei_with_formatted_header(root)
                                    with open(str(new_file_path), 'w', encoding='utf-8') as f:
                                        f.write('<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n' + formatted_xml)
                                print(f"  [MIGRATED] {version_file.relative_to(source_dir)} -> {new_file_path.relative_to(target_dir)}")
                            else:
                                # No changes needed, just copy
                                shutil.copy2(version_file, new_file_path)
                                print(f"  [COPIED] {version_file.relative_to(source_dir)} -> {new_file_path.relative_to(target_dir)}")
                                
                        except Exception as e:
                            print(f"  [ERROR] Failed to migrate version file {version_file}: {e}")
                            # Fallback to copying the original file
                            shutil.copy2(version_file, new_file_path)
                            print(f"  [COPIED] {version_file.relative_to(source_dir)} -> {new_file_path.relative_to(target_dir)} (fallback)")
                    else:
                        # Non-TEI files, just copy
                        shutil.copy2(version_file, new_file_path)
                        print(f"  [COPIED] {version_file.relative_to(source_dir)} -> {new_file_path.relative_to(target_dir)}")
    
    return migrated_count


if __name__ == "__main__":
    sys.exit(main())