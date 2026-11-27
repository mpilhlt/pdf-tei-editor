"""
Unit tests for the Tesseract model folders: link folder, best-model download and plugin setup.

@testCovers fastapi_app/plugins/ocrmypdf/tessdata.py
@testCovers fastapi_app/plugins/ocrmypdf/plugin.py
"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi_app.plugins.ocrmypdf import tessdata
from fastapi_app.plugins.ocrmypdf.engine import OcrmypdfEngine
from fastapi_app.plugins.ocrmypdf.plugin import OcrmypdfPlugin
from fastapi_app.plugins.ocrmypdf.tessdata import build_link_dir, download_best_models, parse_languages


class TestLinkDir(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.system = root / "system"
        (self.system / "configs").mkdir(parents=True)
        (self.system / "configs" / "tsv").write_text("tessedit_create_tsv 1\n")
        (self.system / "deu.traineddata").write_bytes(b"fast deu")
        (self.system / "osd.traineddata").write_bytes(b"osd")
        self.best = root / "shared" / "tesseract" / "tessdata_best-4.1.0"
        self.best.mkdir(parents=True)
        (self.best / "deu.traineddata").write_bytes(b"best deu")
        self.link = root / "data" / "plugins" / "ocrmypdf" / "tessdata"

    def assert_links(self) -> None:
        names = sorted(entry.name for entry in self.link.iterdir())
        self.assertEqual(names, ["best", "configs", "deu.traineddata", "osd.traineddata"])
        self.assertEqual((self.link / "deu.traineddata").read_bytes(), b"fast deu")
        self.assertEqual((self.link / "configs" / "tsv").read_text(), "tessedit_create_tsv 1\n")
        self.assertEqual((self.link / "best" / "deu.traineddata").read_bytes(), b"best deu")
        # no temporary folders are left next to the link folder
        self.assertEqual([entry.name for entry in self.link.parent.iterdir()], ["tessdata"])

    def test_build(self) -> None:
        self.assertTrue(build_link_dir(self.system, self.best, self.link))
        self.assert_links()

    def test_up_to_date_folder_is_kept(self) -> None:
        build_link_dir(self.system, self.best, self.link)
        inode = self.link.stat().st_ino
        self.assertFalse(build_link_dir(self.system, self.best, self.link))
        self.assertEqual(self.link.stat().st_ino, inode)

    def test_rebuild_when_system_models_change(self) -> None:
        build_link_dir(self.system, self.best, self.link)
        (self.system / "fra.traineddata").write_bytes(b"fast fra")
        self.assertTrue(build_link_dir(self.system, self.best, self.link))
        self.assertEqual((self.link / "fra.traineddata").read_bytes(), b"fast fra")

    def test_system_best_entry_is_replaced(self) -> None:
        # a "best" folder in the system folder (e.g. from an older image) is not linked
        (self.system / "best").mkdir()
        build_link_dir(self.system, self.best, self.link)
        self.assertEqual((self.link / "best").resolve(), self.best.resolve())

    def test_system_dir_ignores_own_prefix(self) -> None:
        output = f'List of available languages in "{self.system}/" (2):\ndeu\nosd\n'
        completed = MagicMock(stdout=output)
        with patch.dict(os.environ, {"TESSDATA_PREFIX": str(self.link)}), patch("subprocess.run", return_value=completed) as run:
            self.link.mkdir(parents=True)
            self.assertEqual(tessdata.system_tessdata_dir(self.link), Path(f"{self.system}/"))
            self.assertNotIn("TESSDATA_PREFIX", run.call_args.kwargs["env"])


class TestParseLanguages(unittest.TestCase):
    def test_parse(self) -> None:
        self.assertEqual(parse_languages("eng deu"), ["eng", "deu"])
        self.assertEqual(parse_languages("eng, deu,eng"), ["eng", "deu"])
        self.assertEqual(parse_languages(["eng", "chi_sim"]), ["eng", "chi_sim"])
        self.assertEqual(parse_languages(""), [])
        self.assertEqual(parse_languages(None), [])

    def test_invalid_codes_are_dropped(self) -> None:
        with self.assertLogs(tessdata.logger, level="WARNING"):
            self.assertEqual(parse_languages("deu ../etc"), ["deu"])


class TestDownloadBestModels(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.best = Path(self.tmp.name)
        (self.best / "deu.traineddata").write_bytes(b"present")

    def test_downloads_missing_models(self) -> None:
        callback = MagicMock()
        with patch.object(tessdata, "download_shared_file", return_value=True) as download:
            download_best_models(["deu", "eng", "fra"], self.best, callback)
        urls = [call.args[0] for call in download.call_args_list]
        self.assertEqual(urls, [
            "https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/eng.traineddata",
            "https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/fra.traineddata",
        ])
        self.assertEqual(callback.call_count, 2)

    def test_failure_continues_with_next_language(self) -> None:
        callback = MagicMock()
        with patch.object(tessdata, "download_shared_file", side_effect=[OSError("offline"), True]), self.assertLogs(tessdata.logger, level="WARNING"):
            download_best_models(["eng", "fra"], self.best, callback)
        callback.assert_called_once()

    def test_no_callback_if_another_process_downloads(self) -> None:
        callback = MagicMock()
        with patch.object(tessdata, "download_shared_file", return_value=False):
            download_best_models(["eng"], self.best, callback)
        callback.assert_not_called()


class TestEngineModelCache(unittest.TestCase):
    def test_invalidate_models_shows_best_option(self) -> None:
        engine = OcrmypdfEngine()
        engine._tesseract_codes = ["deu"]
        self.assertNotIn("model", engine.get_options())
        engine.invalidate_models()
        with patch.object(engine, "_get_tesseract_codes", return_value=["deu", "best/deu"]):
            self.assertIn("model", engine.get_options())
        self.assertIsNone(engine._tesseract_codes)


class TestPluginSetup(unittest.TestCase):
    def test_setup_failure_keeps_engine(self) -> None:
        with patch("fastapi_app.plugins.ocrmypdf.plugin.get_plugin_config", return_value="deu"):
            plugin = OcrmypdfPlugin()
        registry = MagicMock()
        with (
            patch("fastapi_app.plugins.ocrmypdf.plugin.OcrEngineRegistry.get_instance", return_value=registry),
            patch.object(tessdata, "system_tessdata_dir", return_value=Path("/nonexistent")),
            patch("fastapi_app.plugins.ocrmypdf.plugin.get_shared_data_dir", side_effect=PermissionError("read-only")),
            patch("threading.Thread") as thread,
            self.assertLogs("fastapi_app.plugins.ocrmypdf.plugin", level="WARNING"),
        ):
            asyncio.run(plugin.initialize(MagicMock()))
        registry.register.assert_called_once()
        thread.assert_not_called()


if __name__ == "__main__":
    unittest.main()
