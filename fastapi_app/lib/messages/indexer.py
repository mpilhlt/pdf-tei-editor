"""
Message indexer: finds the review marks and comments in a TEI file that address users and keeps
the message index (`store.py`) up to date (see docs/user-manual/messages.md).

Who receives what:

- Each current not-OK mark (`r:` keys) goes to the nearest owner (`created_by`) in the file's version
  lineage (the file, its parent, the parent's parent, ...) who is not the reviewer: the file's owner when
  the mark was set in place, the owner of the copied version when a reviewer marked their own copy
  (owner-based access control). All not-OK marks of one LLM reviewer in a file are one message.
- Users mentioned in a not-OK mark's comment receive it as a mention.
- A comment (`c:` keys) addresses the users mentioned in it, and, for replies, the thread's
  author and the users mentioned earlier in the thread. Nobody receives their own comment or mark.
- A review request (`q:` keys): while the last `revisionDesc/change` of a file has the status
  `in-review`, all users with the reviewer role receive a message from the person who saved the
  revision that set it. Further revisions that keep the status belong to the same request.

Settling: a resolved thread settles its comments. A not-OK mark that disappears from a file that
is saved again (unit edited, mark changed to OK), and a review request whose status was changed,
stay in the index as settled occurrences, so the message stays in the recipient's list.

The same comment or mark in several files (copies of a document) is one message, whose newest
occurrence decides its data.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field

from lxml import etree

from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.xml_utils import parse_untrusted_xml

from .mentions import find_mentions, mentionable_ids
from .standoff_reader import (
    COMMENT_LIST_TYPE,
    REVIEW_LIST_TYPE,
    TEI_NS,
    Reviewer,
    build_threads,
    element_by_path,
    element_excerpt,
    find_standoff_list,
    find_units,
    read_comments,
    read_review_data,
    resp_persons,
)
from .store import MessageKind, MessageReason, MessageStore, Occurrence

logger = logging.getLogger(__name__)

# Notes on settled messages
SETTLED_RESOLVED = "resolved"
SETTLED_UNIT_EDITED = "unit-edited"
SETTLED_CHANGED_TO_OK = "changed-to-ok"
SETTLED_SUPERSEDED = "superseded"
SETTLED_STATUS_CHANGED = "status-changed"

# Revision status that asks the reviewers to review a document
REVIEW_REQUEST_STATUS = "in-review"

# Suffix of the key of the collapsed message of an LLM reviewer
LLM_RUN_PREFIX = "run-"


@dataclass
class UserInfo:
    """A user account as far as messages need it."""

    username: str
    fullname: str | None
    roles: list[str] = field(default_factory=list)


@dataclass
class IndexContext:
    """Data that does not depend on the file being indexed."""

    users: dict[str, UserInfo]
    review_mode: str  # 'majority' or 'final'


def review_key(doc_id: str, variant: str | None, reviewer_id: str, fingerprint: str) -> str:
    """Message key of a review mark."""
    return f"r:{doc_id}:{variant or ''}:{reviewer_id}:{fingerprint}"


def review_request_key(doc_id: str, variant: str | None, when: str) -> str:
    """Message key of a review request: the time of the revision that set the status."""
    return f"q:{doc_id}:{variant or ''}:{when}"


def _review_request(root: etree._Element) -> tuple[str, str, str] | None:  # type: ignore[name-defined]
    """
    The open review request of a TEI file, as (time, author id, revision description) of the
    revision that set the `in-review` status, or None if the last revision has another status.
    """
    changes = root.findall(f"{{{TEI_NS}}}teiHeader/{{{TEI_NS}}}revisionDesc/{{{TEI_NS}}}change")
    first = None
    for change in reversed(changes):
        if change.get("status") != REVIEW_REQUEST_STATUS:
            break
        first = change
    if first is None:
        return None
    desc = first.find(f"{{{TEI_NS}}}desc")
    text = " ".join("".join(desc.itertext()).split()) if desc is not None else ""
    return first.get("when") or "", (first.get("who") or "").lstrip("#"), text


def comment_key(doc_id: str, comment_id: str) -> str:
    """Message key of a comment."""
    return f"c:{doc_id}:{comment_id}"


def _file_time(file: FileMetadata) -> str:
    return file.updated_at.isoformat()


def _overridden_by_final_ok(reviewers: list[Reviewer], reviewer: Reviewer, fingerprint: str) -> bool:
    """Whether another person's final OK on the unit decides it (`final` review mode)."""
    for other in reviewers:
        mark = other.marks.get(fingerprint)
        if other is not reviewer and not other.is_llm and mark and mark.final and mark.state == "ok":
            return True
    return False


def extract_occurrences(
    root: etree._Element,  # type: ignore[name-defined]
    file: FileMetadata,
    context: IndexContext,
    lineage_owners: list[str] | None = None,
) -> list[Occurrence]:
    """
    The current message sources of a TEI file.

    Args:
        root: Parsed TEI document
        file: The file's metadata (owner, doc_id, variant, updated_at)
        context: Users and review mode
        lineage_owners: Owners of the file and its ancestors, nearest first; defaults to the file's owner

    Returns:
        One occurrence per (key, recipient)
    """
    persons = resp_persons(root)
    usernames = set(context.users)
    known = mentionable_ids(set(persons), file.created_by, usernames)
    owners = [o for o in (lineage_owners if lineage_owners is not None else [file.created_by]) if o in usernames]

    def owner_for(reviewer_id: str) -> str | None:
        return next((o for o in owners if o != reviewer_id), None)

    file_time = _file_time(file)
    found: dict[tuple[str, str], Occurrence] = {}

    def display_name(user_id: str, fallback: str | None = None) -> str:
        user = context.users.get(user_id)
        return persons.get(user_id) or (user.fullname if user and user.fullname else None) or fallback or user_id

    def add(key: str, recipient: str, kind: MessageKind, reason: MessageReason, author: str, author_name: str,
            text: str, excerpt: str | None, thread_id: str | None, fingerprint: str | None, settled: bool,
            settled_note: str | None, created_at: str | None) -> None:
        if recipient == author or recipient not in usernames or (key, recipient) in found:
            return
        found[(key, recipient)] = Occurrence(
            key=key, recipient=recipient, stable_id=file.stable_id, doc_id=file.doc_id, kind=kind, reason=reason,
            author=author, author_name=author_name, text=text, excerpt=excerpt, thread_id=thread_id,
            fingerprint=fingerprint, settled=settled, settled_note=settled_note, source_created_at=created_at,
            file_updated_at=file_time,
        )

    # ── review marks
    review = read_review_data(find_standoff_list(root, REVIEW_LIST_TYPE))
    if review.reviewers:
        try:
            units = find_units(root, review.unit_path)
        except ValueError:
            units = []
        order = {u.fingerprint: i for i, u in enumerate(units)}
        excerpts = {u.fingerprint: element_excerpt(u.element) for u in units}
        reviewers = list(review.reviewers.values())
        for reviewer in reviewers:
            not_ok = [
                (fp, mark) for fp, mark in reviewer.marks.items()
                if mark.state == "not-ok"
                and not (context.review_mode == "final" and _overridden_by_final_ok(reviewers, reviewer, fp))
            ]
            not_ok.sort(key=lambda item: order.get(item[0], len(order)))
            if not not_ok:
                continue
            author_name = reviewer.name or display_name(reviewer.id)
            owner = owner_for(reviewer.id)
            if reviewer.is_llm:
                if owner:
                    first_fp = not_ok[0][0]
                    count = len(not_ok)
                    text = f"{author_name} flagged {count} unit{'s' if count != 1 else ''}"
                    key = review_key(file.doc_id, file.variant, reviewer.id, LLM_RUN_PREFIX + (reviewer.when or ""))
                    add(key, owner, "review", "owner", reviewer.id, author_name, text, excerpts.get(first_fp),
                        None, first_fp, False, None, reviewer.when)
                continue
            for fp, mark in not_ok:
                key = review_key(file.doc_id, file.variant, reviewer.id, fp)
                if owner:
                    add(key, owner, "review", "owner", reviewer.id, author_name, mark.comment, excerpts.get(fp),
                        None, fp, False, None, None)
                for mentioned in find_mentions(mark.comment, known):
                    add(key, mentioned, "mention", "mention", reviewer.id, author_name, mark.comment,
                        excerpts.get(fp), None, fp, False, None, None)

    # ── review request
    request = _review_request(root)
    if request:
        when, author, text = request
        key = review_request_key(file.doc_id, file.variant, when)
        for user in context.users.values():
            if "reviewer" in user.roles:
                add(key, user.username, "review-request", "reviewer", author, display_name(author), text, None,
                    None, None, False, None, when or None)

    # ── comments
    for thread in build_threads(read_comments(find_standoff_list(root, COMMENT_LIST_TYPE))):
        element = element_by_path(root, thread.root.path) if thread.root.path else None
        excerpt = element_excerpt(element) if element is not None else None
        settled = thread.status == "resolved"
        note = SETTLED_RESOLVED if settled else None
        mentioned_before: list[str] = []
        for comment in [thread.root, *thread.replies]:
            mentions = find_mentions(comment.text, known)
            recipients: list[tuple[str, MessageReason]] = [(m, "mention") for m in mentions]
            if comment is not thread.root:
                recipients.append((thread.root.author, "thread-author"))
                recipients.extend((m, "thread-mention") for m in mentioned_before)
            created_at = comment.changes[0].when if comment.changes else None
            for recipient, reason in recipients:
                add(comment_key(file.doc_id, comment.id), recipient, "comment", reason, comment.author,
                    display_name(comment.author), comment.text, excerpt, thread.root.id, thread.root.fingerprint,
                    settled, note, created_at)
            mentioned_before.extend(m for m in mentions if m not in mentioned_before)

    return list(found.values())


def _settle(occurrence: Occurrence, file_time: str, reviewer_ok: set[tuple[str, str]]) -> Occurrence:
    """A review mark or request occurrence that has gone from the file, turned into a settled one."""
    if occurrence.settled:
        return occurrence
    if occurrence.key.startswith("q:"):
        occurrence.settled = True
        occurrence.settled_note = SETTLED_STATUS_CHANGED
        occurrence.file_updated_at = file_time
        return occurrence
    # r:<doc_id>:<variant>:<reviewer id>:<fingerprint>; the doc_id may contain colons
    parts = occurrence.key.rsplit(":", 2)
    reviewer_id, last = (parts[1], parts[2]) if len(parts) == 3 else ("", "")
    if last.startswith(LLM_RUN_PREFIX):
        note = SETTLED_SUPERSEDED
    elif (reviewer_id, last) in reviewer_ok:
        note = SETTLED_CHANGED_TO_OK
    else:
        note = SETTLED_UNIT_EDITED
    occurrence.settled = True
    occurrence.settled_note = note
    occurrence.file_updated_at = file_time
    return occurrence


class MessageIndexer:
    """Updates the message index from the TEI files."""

    def __init__(
        self,
        store: MessageStore,
        file_repo: FileRepository,
        file_storage: FileStorage,
        context_provider: Callable[[], IndexContext],
    ):
        """
        Args:
            store: The message index
            file_repo: File metadata
            file_storage: File contents
            context_provider: Returns the current users and review mode
        """
        self.store = store
        self.file_repo = file_repo
        self.file_storage = file_storage
        self.context_provider = context_provider

    def index_file(self, stable_id: str, context: IndexContext | None = None) -> set[str]:
        """
        Re-indexes one file after it was saved, created or changed.

        Args:
            stable_id: The file
            context: Users and review mode; fetched if not given

        Returns:
            The recipients whose messages changed
        """
        file = self.file_repo.get_file_by_stable_id(stable_id)
        if file is None or file.deleted or file.file_type != "tei":
            return self.remove_file(stable_id)
        content = self.file_storage.read_file(file.id, "tei")
        if content is None:
            return self.remove_file(stable_id)
        try:
            root = parse_untrusted_xml(content)
        except etree.XMLSyntaxError as e:
            logger.warning("Cannot index messages of %s: %s", stable_id, e)
            return set()
        context = context or self.context_provider()
        current = extract_occurrences(root, file, context, self._lineage_owners(file))
        current_ids = {(o.key, o.recipient) for o in current}

        # review marks and requests that are gone stay as settled occurrences
        review = read_review_data(find_standoff_list(root, REVIEW_LIST_TYPE))
        reviewer_ok = {(r.id, fp) for r in review.reviewers.values() for fp, m in r.marks.items() if m.state == "ok"}
        previous = self.store.occurrences_of_file(stable_id)
        kept = [
            _settle(o, _file_time(file), reviewer_ok)
            for o in previous
            if (o.key, o.recipient) not in current_ids and o.key.startswith(("r:", "q:"))
        ]
        self.store.replace_file_occurrences(stable_id, current + kept)

        touched = current_ids | {(o.key, o.recipient) for o in previous}
        return self._refresh(touched)

    def _lineage_owners(self, file: FileMetadata) -> list[str]:
        """Owners of the file and its ancestors (`parent_stable_id`), nearest first, without repeats."""
        owners: list[str] = []
        seen: set[str] = set()
        current: FileMetadata | None = file
        while current is not None and current.stable_id not in seen:
            seen.add(current.stable_id)
            if current.created_by and current.created_by not in owners:
                owners.append(current.created_by)
            parent = current.parent_stable_id
            current = self.file_repo.get_file_by_stable_id(parent, include_deleted=True) if parent else None
        return owners

    def remove_file(self, stable_id: str) -> set[str]:
        """
        Removes the occurrences of a file (deleted, or no longer a TEI file).

        Returns:
            The recipients whose messages changed
        """
        previous = self.store.occurrences_of_file(stable_id)
        if not previous:
            return set()
        self.store.replace_file_occurrences(stable_id, [])
        return self._refresh({(o.key, o.recipient) for o in previous})

    def rebuild(self) -> int:
        """
        Rebuilds the index from all TEI files. Keeps the read state; settled messages of marks that
        are no longer in any file are lost.

        Returns:
            The number of indexed files
        """
        self.store.clear_index()
        context = self.context_provider()
        files = self.file_repo.list_files(file_type="tei")
        for file in files:
            try:
                self.index_file(file.stable_id, context)
            except Exception as e:  # noqa: BLE001 - one broken file must not stop the rebuild
                logger.warning("Cannot index messages of %s: %s", file.stable_id, e)
        return len(files)

    def _refresh(self, touched: set[tuple[str, str]]) -> set[str]:
        changed: set[str] = set()
        for key, recipient in touched:
            if self.store.refresh_message(key, recipient):
                changed.add(recipient)
        return changed
