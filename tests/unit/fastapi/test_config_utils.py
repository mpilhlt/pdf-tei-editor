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

from fastapi_app.lib.config_utils import Config


class TestConfigUtils(unittest.TestCase):
    """Test configuration utilities using high-level Config API."""

    def setUp(self):
        """Create temporary directory and Config instance for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)
        self.config = Config(self.db_dir)

    def tearDown(self):
        """Clean up temporary directory."""
        self.temp_dir.cleanup()

    def test_load_creates_empty(self):
        """Test that load creates empty config if not exists."""
        config_data = self.config.load()
        self.assertEqual(config_data, {})
        self.assertTrue((self.db_dir / 'config.json').exists())

    def test_get_default(self):
        """Test getting config value with default."""
        value = self.config.get('nonexistent', default='default_value')
        self.assertEqual(value, 'default_value')

    def test_set_and_get(self):
        """Test setting and getting a config value."""
        success, msg = self.config.set('test.key', 'test_value')
        self.assertTrue(success)
        self.assertIn('test.key', msg)

        value = self.config.get('test.key')
        self.assertEqual(value, 'test_value')

    def test_set_creates_type(self):
        """Test that setting a value auto-creates type metadata."""
        self.config.set('number.value', 42)

        config_data = self.config.load()
        self.assertEqual(config_data['number.value'], 42)
        self.assertEqual(config_data['number.value.type'], 'number')

    def test_set_validates_type(self):
        """Test type validation when type constraint exists."""
        # Set type constraint
        self.config.set('typed.value.type', 'string')

        # Valid: string value
        success, msg = self.config.set('typed.value', 'hello')
        self.assertTrue(success)

        # Invalid: number value with string type constraint
        success, msg = self.config.set('typed.value', 123)
        self.assertFalse(success)
        self.assertIn('validation', msg.lower())

    def test_set_validates_values_constraint(self):
        """Test values constraint validation."""
        # Set allowed values
        self.config.set('mode.values', ['dev', 'prod', 'test'])

        # Valid value
        success, msg = self.config.set('mode', 'dev')
        self.assertTrue(success)

        # Invalid value
        success, msg = self.config.set('mode', 'staging')
        self.assertFalse(success)
        self.assertIn('validation', msg.lower())

    def test_delete(self):
        """Test deleting a config value."""
        self.config.set('delete.me', 'value')

        success, msg = self.config.delete('delete.me')
        self.assertTrue(success)
        self.assertIn('delete.me', msg)

        value = self.config.get('delete.me')
        self.assertIsNone(value)

    def test_delete_nonexistent_key(self):
        """Test deleting a key that doesn't exist."""
        success, msg = self.config.delete('nonexistent')
        self.assertFalse(success)
        self.assertIn('not found', msg.lower())

    def test_values_key_validation(self):
        """Test that .values keys must be arrays."""
        success, msg = self.config.set('key.values', ['a', 'b'])
        self.assertTrue(success)

        success, msg = self.config.set('key.values', 'not-an-array')
        self.assertFalse(success)
        self.assertIn('array', msg.lower())

    def test_type_key_validation(self):
        """Test that .type keys must be valid JSON types."""
        success, msg = self.config.set('key.type', 'string')
        self.assertTrue(success)

        success, msg = self.config.set('key.type', 'invalid_type')
        self.assertFalse(success)
        self.assertIn('must be one of', msg.lower())

    @unittest.skipIf(sys.platform == 'win32', 'File locking with concurrent writes is unreliable on Windows')
    def test_concurrent_writes(self):
        """Test that file locking handles concurrent writes."""
        import threading
        import time

        results = []

        def write_value(key, value):
            config = Config(self.db_dir)
            success, msg = config.set(key, value)
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

        # Verify all values are present with retry logic for file system delays
        max_retries = 5
        retry_delay = 0.1
        for attempt in range(max_retries):
            config_data = self.config.load()
            missing_keys = [f'key{i}' for i in range(10) if f'key{i}' not in config_data]

            if not missing_keys:
                # All keys present, verify values
                for i in range(10):
                    self.assertEqual(config_data[f'key{i}'], f'value{i}')
                break
            elif attempt < max_retries - 1:
                # Keys still missing, wait and retry
                time.sleep(retry_delay)
                retry_delay *= 2  # Exponential backoff
            else:
                # Final attempt failed
                self.fail(f"Keys {missing_keys} not found after {max_retries} retries. "
                         f"Config keys: {list(config_data.keys())}")

    def test_dot_notation_keys(self):
        """Test that dot notation keys work correctly."""
        self.config.set('session.timeout', 3600)
        self.config.set('session.cookie.name', 'sessionId')

        self.assertEqual(self.config.get('session.timeout'), 3600)
        self.assertEqual(self.config.get('session.cookie.name'), 'sessionId')


if __name__ == '__main__':
    unittest.main()
