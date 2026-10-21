"""
Regression test: the extractor's get_info()["annotationGuides"] must validate
against the shared AnnotationGuideInfo/ExtractorInfo Pydantic models. A schema
drift here previously caused HTTP 500 on the entire /api/v1/extract/list
endpoint, because extraction.py's router has no per-extractor error isolation.

@testCovers fastapi_app/plugins/llamore_extractor/extractor.py
"""

import unittest

from fastapi_app.lib.models.models_extraction import ExtractorInfo


class TestExtractorInfoValidation(unittest.TestCase):
    def test_llamore_extractor_info_validates(self):
        from fastapi_app.plugins.llamore_extractor.extractor import LLamoreExtractor
        info = LLamoreExtractor.get_info()
        ExtractorInfo(**{**info, "available": True})


if __name__ == "__main__":
    unittest.main()
