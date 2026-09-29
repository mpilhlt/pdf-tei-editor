"""
Unit tests for the resource-kind registry.

@testCovers fastapi_app/lib/doc_rules/kinds.py
"""

import unittest

from fastapi_app.lib.doc_rules.kinds import (
    ResourceDescriptor,
    ResourceKind,
    ResourceKindRegistry,
    get_resource_kind,
    list_resources,
    register_resource_kind,
)


class _FakeKind(ResourceKind):
    name = "fake-kind"

    def __init__(self, descriptors):
        self._descriptors = descriptors

    def discover(self, xml_string):
        return self._descriptors

    def resolve_original(self, url):
        return f"original:{url}"


class TestResourceKindRegistry(unittest.TestCase):
    def setUp(self):
        # Isolate from the process-wide singleton and its built-in kinds.
        self._saved_instance = ResourceKindRegistry._instance
        ResourceKindRegistry._instance = ResourceKindRegistry()

    def tearDown(self):
        ResourceKindRegistry._instance = self._saved_instance

    def test_register_and_get(self):
        kind = _FakeKind([])
        register_resource_kind(kind)
        self.assertIs(get_resource_kind("fake-kind"), kind)

    def test_get_unregistered_kind_returns_none(self):
        self.assertIsNone(get_resource_kind("does-not-exist"))

    def test_list_resources_concatenates_all_registered_kinds(self):
        d1 = ResourceDescriptor(kind="fake-kind", url="https://a", key="https://a", label="A", format="text")
        d2 = ResourceDescriptor(kind="fake-kind", url="https://b", key="https://b", label="B", format="text")
        register_resource_kind(_FakeKind([d1]))

        class _OtherKind(_FakeKind):
            name = "other-kind"

        register_resource_kind(_OtherKind([d2]))

        self.assertEqual(list_resources("<xml/>"), [d1, d2])


class TestBuiltinKindsRegisterLazily(unittest.TestCase):
    """Uses the real, process-wide singleton (not reset), so built-ins are exercised."""

    def test_interpretation_ref_and_schema_are_registered(self):
        self.assertIsNotNone(get_resource_kind("interpretation-ref"))
        self.assertIsNotNone(get_resource_kind("schema"))
