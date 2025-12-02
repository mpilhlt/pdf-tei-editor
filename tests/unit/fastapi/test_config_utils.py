"""
Unit tests for config_utils.py

Self-contained tests that can be run independently.

@testCovers fastapi_app/lib/config_utils.py
"""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.config_utils import (
    load_full_config,
    get_config_value,
    set_config_value,
    delete_config_value,
    _get_json_type,
    _validate_config_value
)


class TestConfigUtils(unittest.TestCase):
    """Test configuration utilities."""

    def setUp(self):
        """Create temporary directory for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)

    def tearDown(self):
        """Clean up temporary directory."""
        self.temp_dir.cleanup()

    def test_load_full_config_creates_empty(self):
        """Test that load_full_config creates empty config if not exists."""
        config = load_full_config(self.db_dir)
        self.assertEqual(config, {})
        self.assertTrue((self.db_dir / 'config.json').exists())

    def test_get_config_value_default(self):
        """Test getting config value with default."""
        value = get_config_value('nonexistent', self.db_dir, default='default_value')
        self.assertEqual(value, 'default_value')

    def test_set_and_get_config_value(self):
        """Test setting and getting a config value."""
        success, msg = set_config_value('test.key', 'test_value', self.db_dir)
        self.assertTrue(success)
        self.assertIn('test.key', msg)

        value = get_config_value('test.key', self.db_dir)
        self.assertEqual(value, 'test_value')

    def test_set_config_value_creates_type(self):
        """Test that setting a value auto-creates type metadata."""
        set_config_value('number.value', 42, self.db_dir)

        config = load_full_config(self.db_dir)
        self.assertEqual(config['number.value'], 42)
        self.assertEqual(config['number.value.type'], 'number')

    def test_set_config_value_validates_type(self):
        """Test type validation when type constraint exists."""
        # Set type constraint
        set_config_value('typed.value.type', 'string', self.db_dir)

        # Valid: string value
        success, msg = set_config_value('typed.value', 'hello', self.db_dir)
        self.assertTrue(success)

        # Invalid: number value with string type constraint
        success, msg = set_config_value('typed.value', 123, self.db_dir)
        self.assertFalse(success)
        self.assertIn('validation', msg.lower())

    def test_set_config_value_validates_values_constraint(self):
        """Test values constraint validation."""
        # Set allowed values
        set_config_value('mode.values', ['dev', 'prod', 'test'], self.db_dir)

        # Valid value
        success, msg = set_config_value('mode', 'dev', self.db_dir)
        self.assertTrue(success)

        # Invalid value
        success, msg = set_config_value('mode', 'staging', self.db_dir)
        self.assertFalse(success)
        self.assertIn('validation', msg.lower())

    def test_delete_config_value(self):
        """Test deleting a config value."""
        set_config_value('delete.me', 'value', self.db_dir)

        success, msg = delete_config_value('delete.me', self.db_dir)
        self.assertTrue(success)
        self.assertIn('delete.me', msg)

        value = get_config_value('delete.me', self.db_dir)
        self.assertIsNone(value)

    def test_delete_nonexistent_key(self):
        """Test deleting a key that doesn't exist."""
        success, msg = delete_config_value('nonexistent', self.db_dir)
        self.assertFalse(success)
        self.assertIn('not found', msg.lower())

    def test_get_json_type(self):
        """Test JSON type detection."""
        self.assertEqual(_get_json_type(True), 'boolean')
        self.assertEqual(_get_json_type(42), 'number')
        self.assertEqual(_get_json_type(3.14), 'number')
        self.assertEqual(_get_json_type('string'), 'string')
        self.assertEqual(_get_json_type([1, 2, 3]), 'array')
        self.assertEqual(_get_json_type({'key': 'value'}), 'object')
        self.assertEqual(_get_json_type(None), 'null')

    def test_validate_config_value_type(self):
        """Test config value type validation."""
        config_data = {
            'key.type': 'string'
        }

        self.assertTrue(_validate_config_value(config_data, 'key', 'hello'))
        self.assertFalse(_validate_config_value(config_data, 'key', 123))

    def test_validate_config_value_values(self):
        """Test config value values constraint validation."""
        config_data = {
            'key.values': ['a', 'b', 'c']
        }

        self.assertTrue(_validate_config_value(config_data, 'key', 'a'))
        self.assertFalse(_validate_config_value(config_data, 'key', 'd'))

    def test_validate_config_value_both_constraints(self):
        """Test validation with both type and values constraints."""
        config_data = {
            'key.type': 'string',
            'key.values': ['dev', 'prod']
        }

        self.assertTrue(_validate_config_value(config_data, 'key', 'dev'))
        self.assertFalse(_validate_config_value(config_data, 'key', 'test'))  # not in values
        self.assertFalse(_validate_config_value(config_data, 'key', 123))  # wrong type

    def test_values_key_validation(self):
        """Test that .values keys must be arrays."""
        success, msg = set_config_value('key.values', ['a', 'b'], self.db_dir)
        self.assertTrue(success)

        success, msg = set_config_value('key.values', 'not-an-array', self.db_dir)
        self.assertFalse(success)
        self.assertIn('array', msg.lower())

    def test_type_key_validation(self):
        """Test that .type keys must be valid JSON types."""
        success, msg = set_config_value('key.type', 'string', self.db_dir)
        self.assertTrue(success)

        success, msg = set_config_value('key.type', 'invalid_type', self.db_dir)
        self.assertFalse(success)
        self.assertIn('must be one of', msg.lower())

    @unittest.skipIf(sys.platform == 'win32', 'File locking with concurrent writes is unreliable on Windows')
    def test_concurrent_writes(self):
        """Test that file locking handles concurrent writes."""
        import threading

        results = []

        def write_value(key, value):
            success, msg = set_config_value(key, value, self.db_dir)
            results.append((key, success))

        # Start multiple threads writing different keys
        threads = []
        for i in range(10):
            t = threading.Thread(target=write_value, args=(f'key{i}', f'value{i}'))
            threads.append(t)
            t.start()

        # Wait for all threads
        for t in threads:
            t.join()

        # All writes should succeed
        self.assertEqual(len(results), 10)
        for key, success in results:
            self.assertTrue(success, f"Write failed for {key}")

        # Verify all values are present
        import time
        time.sleep(0.1)  # Small delay to ensure all writes are flushed
        config = load_full_config(self.db_dir)
        for i in range(10):
            self.assertIn(f'key{i}', config, f"key{i} not found in config. Config keys: {list(config.keys())}")
            self.assertEqual(config[f'key{i}'], f'value{i}')

    def test_dot_notation_keys(self):
        """Test that dot notation keys work correctly."""
        set_config_value('session.timeout', 3600, self.db_dir)
        set_config_value('session.cookie.name', 'sessionId', self.db_dir)

        self.assertEqual(get_config_value('session.timeout', self.db_dir), 3600)
        self.assertEqual(get_config_value('session.cookie.name', self.db_dir), 'sessionId')


if __name__ == '__main__':
    unittest.main()
