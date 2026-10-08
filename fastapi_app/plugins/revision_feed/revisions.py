"""
Revision extraction and Atom feed building for the revision feed plugin.

Parses every <tei:revisionDesc><tei:change> in a TEI document (not just the
last one, unlike edit_history's _extract_revision_info) and renders the
qualifying changes as a hand-rolled Atom 1.0 feed via lxml - there is no
feed-generation library in this project's dependencies.
"""

from dataclasses import dataclass
from datetime import UTC, datetime

from lxml import etree

from fastapi_app.lib.utils.tei_utils import get_annotator_name

TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}
ATOM_NS = "http://www.w3.org/2005/Atom"


@dataclass
class RevisionEntry:
    stable_id: str
    doc_label: str
    status: str
    when: datetime  # must be naive and already UTC-converted; build_atom_feed appends "Z" blindly
    who: str
    description: str
    collection_id: str


def extract_revision_entries(
    xml_content: str,
    stable_id: str,
    doc_label: str,
    collection_id: str,
    included_statuses: list[str],
) -> list[RevisionEntry]:
    """Parse every revisionDesc/change whose @status is in included_statuses."""
    root = etree.fromstring(xml_content.encode("utf-8"))
    entries: list[RevisionEntry] = []

    for change in root.findall(".//tei:revisionDesc/tei:change", TEI_NS):
        status = change.get("status", "draft")
        if status not in included_statuses:
            continue

        when_raw = change.get("when", "")
        try:
            when = datetime.fromisoformat(when_raw)
            if when.tzinfo is not None:
                when = when.astimezone(UTC).replace(tzinfo=None)
        except (ValueError, AttributeError):
            continue

        who_id = change.get("who", "")
        who = get_annotator_name(root, who_id) if who_id else "Unknown"

        desc_elem = change.find("tei:desc", TEI_NS)
        if desc_elem is not None and desc_elem.text:
            description = desc_elem.text.strip()
        elif change.text and change.text.strip():
            description = change.text.strip()
        else:
            description = "No description"

        entries.append(
            RevisionEntry(
                stable_id=stable_id,
                doc_label=doc_label,
                status=status,
                when=when,
                who=who,
                description=description,
                collection_id=collection_id,
            )
        )

    return entries


def build_atom_feed(
    project_id: str,
    project_name: str,
    feed_url: str,
    entries: list[RevisionEntry],
    app_base_url: str,
    max_entries: int = 50,
) -> str:
    """Build an Atom 1.0 XML document (as a UTF-8 string) from revision entries."""
    sorted_entries = sorted(entries, key=lambda entry: entry.when, reverse=True)[:max_entries]

    feed = etree.Element("feed", nsmap={None: ATOM_NS})  # type: ignore[dict-item]

    etree.SubElement(feed, "title").text = f"{project_name} — Revision Feed"
    etree.SubElement(feed, "id").text = f"urn:revision-feed:project:{project_id}"

    latest_when = sorted_entries[0].when if sorted_entries else datetime.now(UTC)
    etree.SubElement(feed, "updated").text = latest_when.strftime("%Y-%m-%dT%H:%M:%SZ")
    etree.SubElement(feed, "link", rel="self", href=feed_url)

    for entry in sorted_entries:
        entry_el = etree.SubElement(feed, "entry")
        etree.SubElement(entry_el, "title").text = f"{entry.doc_label} — {entry.status}"
        etree.SubElement(entry_el, "id").text = (
            f"urn:revision-feed:{entry.stable_id}:{entry.when.isoformat()}:{entry.status}"
        )
        etree.SubElement(entry_el, "updated").text = entry.when.strftime("%Y-%m-%dT%H:%M:%SZ")

        author_el = etree.SubElement(entry_el, "author")
        etree.SubElement(author_el, "name").text = entry.who

        etree.SubElement(entry_el, "summary").text = entry.description

        doc_link = f"{app_base_url.rstrip('/')}/#xml={entry.stable_id}&collection={entry.collection_id}"
        etree.SubElement(entry_el, "link", href=doc_link)

    return etree.tostring(
        feed, xml_declaration=True, encoding="UTF-8", pretty_print=True
    ).decode("utf-8")
