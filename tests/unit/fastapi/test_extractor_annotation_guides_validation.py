"""
Regression test: every registered extractor's get_info()["annotationGuides"]
must validate against the shared AnnotationGuideInfo/ExtractorInfo Pydantic
models. A schema drift here previously caused HTTP 500 on the entire
/api/v1/extract/list endpoint whenever GROBID was configured, because
extraction.py's router has no per-extractor error isolation.

@testCovers fastapi_app/lib/models/models_extraction.py
@testCovers fastapi_app/plugins/grobid/extractor.py
@testCovers fastapi_app/plugins/llamore_extractor/extractor.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.models.models_extraction import ExtractorInfo


class TestExtractorAnnotationGuidesValidation(unittest.TestCase):
    def test_grobid_extractor_info_validates(self):
        from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor
        info = GrobidTrainingExtractor.get_info()
        ExtractorInfo(**{**info, "available": True})

    def test_llamore_extractor_info_validates(self):
        from fastapi_app.plugins.llamore_extractor.extractor import LLamoreExtractor
        info = LLamoreExtractor.get_info()
        ExtractorInfo(**{**info, "available": True})


if __name__ == "__main__":
    unittest.main()
