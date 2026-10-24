"""
Unit tests for the message indexer and store: recipients, deduplication across copies,
settling, ownership and read state.

@testCovers fastapi_app/lib/messages/indexer.py
@testCovers fastapi_app/lib/messages/store.py
"""

import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast

from fastapi_app.lib.messages.indexer import (
    SETTLED_CHANGED_TO_OK,
    SETTLED_RESOLVED,
    SETTLED_UNIT_EDITED,
    IndexContext,
    MessageIndexer,
    UserInfo,
)
from fastapi_app.lib.messages.store import MessageStore
from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage

FIXTURE = Path(__file__).parent.parent / "fixtures" / "standoff" / "messages-sample.tei.xml"
USERS = {name: UserInfo(username=name, fullname=None) for name in ("jdoe", "asmith", "bkim", "owner")}
BASE_TIME = datetime(2026, 10, 24, 12, 0, 0)


class FakeFiles:
    """Minimal FileRepository and FileStorage over in-memory files."""

    def __init__(self) -> None:
        self.files: dict[str, FileMetadata] = {}
        self.contents: dict[str, bytes] = {}

    def put(self, stable_id: str, xml: bytes, created_by: str | None = "owner", minutes: int = 0, doc_id: str = "doc1",
            parent: str | None = None) -> None:
        self.files[stable_id] = FileMetadata(
            id=f"hash-{stable_id}-{minutes}", stable_id=stable_id, filename=f"{stable_id}.tei.xml", doc_id=doc_id,
            file_type="tei", file_size=len(xml), variant="grobid", created_by=created_by,
            updated_at=BASE_TIME + timedelta(minutes=minutes), parent_stable_id=parent,
        )
        self.contents[self.files[stable_id].id] = xml

    def get_file_by_stable_id(self, stable_id: str, include_deleted: bool = False) -> FileMetadata | None:
        return self.files.get(stable_id)

    def list_files(self, file_type: str | None = None) -> list[FileMetadata]:
        return list(self.files.values())

    def read_file(self, file_hash: str, file_type: str) -> bytes | None:
        return self.contents.get(file_hash)


class IndexerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = MessageStore(Path(self.tmp.name))
        self.files = FakeFiles()
        self.context = IndexContext(users=USERS, review_mode="majority")
        self.indexer = MessageIndexer(
            self.store, cast(FileRepository, self.files), cast(FileStorage, self.files), lambda: self.context
        )
        self.xml = FIXTURE.read_bytes()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def messages(self, recipient: str) -> dict[str, tuple[str, str, bool]]:
        return {m.key: (m.kind, m.reason, m.settled) for m in self.store.list_messages(recipient)}


class TestRecipients(IndexerTestCase):
    def test_owner_receives_not_ok_marks_of_others(self) -> None:
        changed = self.indexer.index_file("f1")
        self.assertEqual(changed, set())  # not in the repository
        self.files.put("f1", self.xml)
        changed = self.indexer.index_file("f1")
        self.assertIn("owner", changed)
        reviews = {k: v for k, v in self.messages("owner").items() if k.startswith("r:")}
        self.assertEqual(set(reviews), {
            "r:doc1:grobid:asmith:de7bf13a",
            "r:doc1:grobid:asmith:a5cc5d33.2",
            "r:doc1:grobid:llm-openai-gpt:run-2026-10-22T08:30:00Z",
        })
        llm = self.store.get_message("r:doc1:grobid:llm-openai-gpt:run-2026-10-22T08:30:00Z", "owner")
        assert llm is not None
        self.assertEqual(llm.text, "GPT (OpenAI) flagged 2 units")
        self.assertEqual(llm.fingerprint, "de7bf13a")
        self.assertEqual(llm.excerpt, "Ibid., p. 12.")

    def test_final_ok_overrides_not_ok_in_final_mode(self) -> None:
        self.context.review_mode = "final"
        self.files.put("f1", self.xml)
        self.indexer.index_file("f1")
        self.assertNotIn("r:doc1:grobid:asmith:a5cc5d33.2", self.messages("owner"))

    def test_mention_in_mark_comment(self) -> None:
        self.files.put("f1", self.xml)
        self.indexer.index_file("f1")
        self.assertEqual(self.messages("jdoe")["r:doc1:grobid:asmith:de7bf13a"], ("mention", "mention", False))

    def test_comment_recipients(self) -> None:
        self.files.put("f1", self.xml)
        self.indexer.index_file("f1")
        jdoe = self.messages("jdoe")
        asmith = self.messages("asmith")
        bkim = self.messages("bkim")
        # first comment mentions jdoe; "@nobody" is not a user
        self.assertEqual(jdoe["c:doc1:uc-aaa111"], ("comment", "mention", False))
        # jdoe's own reply is not a message for jdoe; it goes to the thread author and mentions bkim
        self.assertNotIn("c:doc1:uc-aaa112", jdoe)
        self.assertEqual(asmith["c:doc1:uc-aaa112"], ("comment", "thread-author", False))
        self.assertEqual(bkim["c:doc1:uc-aaa112"], ("comment", "mention", False))
        # bkim's reply: thread author and the user mentioned earlier
        self.assertEqual(asmith["c:doc1:uc-aaa113"], ("comment", "thread-author", False))
        self.assertEqual(jdoe["c:doc1:uc-aaa113"], ("comment", "thread-mention", False))
        # resolved thread: settled
        self.assertEqual(asmith["c:doc1:uc-bbb221"], ("comment", "mention", True))
        message = self.store.get_message("c:doc1:uc-bbb221", "asmith")
        assert message is not None
        self.assertEqual(message.settled_note, SETTLED_RESOLVED)
        self.assertEqual(message.created_at, "2026-10-23T11:00:00Z")
        # orphan reply is ignored
        self.assertNotIn("c:doc1:uc-ccc331", asmith)

    def test_ownerless_file_has_no_review_messages(self) -> None:
        self.files.put("f1", self.xml, created_by=None)
        self.indexer.index_file("f1")
        self.assertEqual(self.messages("owner"), {})
        self.assertIn("c:doc1:uc-aaa111", self.messages("jdoe"))

    def test_reviewer_owning_file_gets_no_message_for_own_marks(self) -> None:
        self.files.put("f1", self.xml, created_by="asmith")
        self.indexer.index_file("f1")
        self.assertFalse([k for k in self.messages("asmith") if k.startswith("r:doc1:grobid:asmith:")])

    def test_marks_in_reviewers_own_copy_go_to_the_owner_of_the_copied_version(self) -> None:
        self.files.put("f1", b"<TEI xmlns='http://www.tei-c.org/ns/1.0'/>", created_by="owner")
        self.files.put("f2", self.xml, created_by="asmith", minutes=5, parent="f1")
        self.files.put("f3", self.xml, created_by="asmith", minutes=10, parent="f2")
        self.indexer.index_file("f3")
        message = self.store.get_message("r:doc1:grobid:asmith:de7bf13a", "owner")
        assert message is not None
        self.assertEqual(message.stable_id, "f3")
        self.assertFalse([k for k in self.messages("asmith") if k.startswith("r:doc1:grobid:asmith:")])
        # The LLM reviewer's marks go to the copy's owner
        self.assertIn("r:doc1:grobid:llm-openai-gpt:run-2026-10-22T08:30:00Z", self.messages("asmith"))

    def test_lineage_with_a_cycle_ends(self) -> None:
        self.files.put("f1", self.xml, created_by="asmith", parent="f2")
        self.files.put("f2", self.xml, created_by="asmith", parent="f1")
        self.indexer.index_file("f1")
        self.assertEqual(self.messages("owner"), {})


class TestCopiesAndSettling(IndexerTestCase):
    def test_same_comment_in_two_files_is_one_message_from_the_newest(self) -> None:
        self.files.put("f1", self.xml, minutes=0)
        edited = self.xml.replace(b"Yes, it points to the previous entry.", b"Yes, the previous one.")
        self.files.put("f2", edited, minutes=5)
        self.indexer.index_file("f1")
        self.indexer.index_file("f2")
        message = self.store.get_message("c:doc1:uc-aaa112", "asmith")
        assert message is not None
        self.assertEqual(message.stable_id, "f2")
        self.assertEqual(message.text, "Yes, the previous one. @bkim?")
        self.assertEqual(len(self.store.occurrences_of_message("c:doc1:uc-aaa112", "asmith")), 2)

    def test_deleting_a_file_removes_only_its_occurrence(self) -> None:
        self.files.put("f1", self.xml, minutes=0)
        self.files.put("f2", self.xml, minutes=5)
        self.indexer.index_file("f1")
        self.indexer.index_file("f2")
        del self.files.files["f2"]
        self.indexer.index_file("f2")
        message = self.store.get_message("c:doc1:uc-aaa111", "jdoe")
        assert message is not None
        self.assertEqual(message.stable_id, "f1")
        self.indexer.remove_file("f1")
        self.assertIsNone(self.store.get_message("c:doc1:uc-aaa111", "jdoe"))

    def test_removed_not_ok_mark_settles(self) -> None:
        self.files.put("f1", self.xml, minutes=0)
        self.indexer.index_file("f1")
        # the reviewer changes the mark to OK, and the unit with the other mark is edited
        changed = self.xml.replace(b'<note type="ok">1f14d510</note>', b'<note type="ok">1f14d510 de7bf13a</note>')
        changed = changed.replace(b'<note type="not-ok" n="de7bf13a">@jdoe the year is missing &amp; the title</note>', b"")
        changed = changed.replace(b'<note type="not-ok" n="a5cc5d33.2"/>', b"")
        self.files.put("f1", changed, minutes=10)
        changed_recipients = self.indexer.index_file("f1")
        self.assertIn("owner", changed_recipients)
        to_ok = self.store.get_message("r:doc1:grobid:asmith:de7bf13a", "owner")
        edited = self.store.get_message("r:doc1:grobid:asmith:a5cc5d33.2", "owner")
        assert to_ok is not None and edited is not None
        self.assertTrue(to_ok.settled)
        self.assertEqual(to_ok.settled_note, SETTLED_CHANGED_TO_OK)
        self.assertEqual(edited.settled_note, SETTLED_UNIT_EDITED)
        # the mention of jdoe in the removed mark settles too
        mention = self.store.get_message("r:doc1:grobid:asmith:de7bf13a", "jdoe")
        assert mention is not None
        self.assertTrue(mention.settled)

    def test_review_occurrences_only_for_files_of_the_recipient(self) -> None:
        self.files.put("f1", self.xml, created_by="owner", minutes=0)
        self.files.put("f2", self.xml, created_by="bkim", minutes=5)
        self.indexer.index_file("f1")
        self.indexer.index_file("f2")
        message = self.store.get_message("r:doc1:grobid:asmith:de7bf13a", "owner")
        assert message is not None
        self.assertEqual(message.stable_id, "f1")
        self.assertEqual(len(self.store.occurrences_of_message("r:doc1:grobid:asmith:de7bf13a", "owner")), 1)


class TestReadState(IndexerTestCase):
    def test_read_state_survives_rebuild_and_edits(self) -> None:
        self.files.put("f1", self.xml)
        self.indexer.index_file("f1")
        self.store.set_read("jdoe", ["c:doc1:uc-aaa111"], True)
        self.assertEqual([m.key for m in self.store.list_messages("jdoe", unread_only=True)].count("c:doc1:uc-aaa111"), 0)
        self.assertEqual(self.indexer.rebuild(), 1)
        message = self.store.get_message("c:doc1:uc-aaa111", "jdoe")
        assert message is not None
        self.assertTrue(message.read)
        self.store.set_read("jdoe", ["c:doc1:uc-aaa111"], False)
        message = self.store.get_message("c:doc1:uc-aaa111", "jdoe")
        assert message is not None
        self.assertFalse(message.read)

    def test_kind_filter(self) -> None:
        self.files.put("f1", self.xml)
        self.indexer.index_file("f1")
        self.assertTrue(all(m.key.startswith("r:") for m in self.store.list_messages("jdoe", kind="review")))
        self.assertTrue(all(m.key.startswith("c:") for m in self.store.list_messages("jdoe", kind="comment")))

    def test_unchanged_reindex_reports_no_change(self) -> None:
        self.files.put("f1", self.xml)
        self.indexer.index_file("f1")
        self.assertEqual(self.indexer.index_file("f1"), set())


if __name__ == "__main__":
    unittest.main()
