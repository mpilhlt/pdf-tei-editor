#!/usr/bin/env python3
"""
@testCovers bin/manage.py

Integration tests for the config CLI commands in manage.py.

Tests all config management functionality including:
- config get/set/delete operations
- --default flag behavior for dual-file operations
- Value validation and constraint enforcement
- Type validation and auto-typing
- Error handling and edge cases
"""

import unittest
import tempfile
import json
import subprocess
import shutil
import os
from pathlib import Path


class TestConfigCLI(unittest.TestCase):
    """Integration tests for the config CLI commands."""

    def setUp(self):
        """Set up test environment with test data directory."""
        # Use test data directory
        self.test_data_dir = Path(__file__).parent / 'fixtures'
        self.db_dir = self.test_data_dir / 'db'
        self.config_dir = self.test_data_dir / 'config'

        # Create temporary working directory for tests that modify files
        self.temp_root = tempfile.mkdtemp()
        self.temp_db_dir = Path(self.temp_root) / 'db'
        self.temp_config_dir = Path(self.temp_root) / 'config'
        self.temp_db_dir.mkdir(parents=True)
        self.temp_config_dir.mkdir(parents=True)

        # Copy test data to temporary directory
        shutil.copytree(self.db_dir, self.temp_db_dir, dirs_exist_ok=True)
        shutil.copytree(self.config_dir, self.temp_config_dir, dirs_exist_ok=True)

        # Set environment variable to use temporary directory
        os.environ['PDF_TEI_EDITOR_BASE_DIR'] = str(self.temp_root)

        # Path to manage.py script
        self.manage_py = Path(__file__).parent.parent.parent / 'bin' / 'manage.py'

    def tearDown(self):
        """Clean up test environment."""
        # Remove environment variable
        if 'PDF_TEI_EDITOR_BASE_DIR' in os.environ:
            del os.environ['PDF_TEI_EDITOR_BASE_DIR']
        # Clean up temporary directory
        shutil.rmtree(self.temp_root)

    def run_config_command(self, *args, expect_success=True):
        """Run a config command and return the result."""
        cmd = [
            'uv', 'run', 'python', str(self.manage_py),
            'config'
        ] + list(args)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            env=os.environ.copy()
        )

        if expect_success and result.returncode != 0:
            self.fail(f"Command failed: {' '.join(cmd)}\\nStdout: {result.stdout}\\nStderr: {result.stderr}")

        return result

    def load_config_file(self, filename):
        """Load a config file and return the parsed JSON."""
        if filename == 'db':
            config_file = self.temp_db_dir / 'config.json'
        elif filename == 'config':
            config_file = self.temp_config_dir / 'config.json'
        else:
            config_file = Path(filename)

        if not config_file.exists():
            raise RuntimeError(f"Config file does not exist: {config_file}")
        return json.loads(config_file.read_text())

    def test_config_get_db_default(self):
        """Test config get command reading from db config."""
        result = self.run_config_command('get', 'heartbeat.interval')
        self.assertEqual(result.stdout.strip(), '30')

    def test_config_get_default_flag(self):
        """Test config get command with --default flag."""
        result = self.run_config_command('get', 'heartbeat.interval', '--default')
        self.assertEqual(result.stdout.strip(), '60')

    def test_config_get_default_only_key(self):
        """Test getting a key that only exists in default config."""
        result = self.run_config_command('get', 'default.only.setting', '--default')
        self.assertEqual(result.stdout.strip(), '"default_value"')

    def test_config_get_nonexistent_key(self):
        """Test getting a nonexistent key."""
        result = self.run_config_command('get', 'nonexistent.key', expect_success=False)
        self.assertIn("Error: Key 'nonexistent.key' not found", result.stdout)

    def test_config_set_basic(self):
        """Test basic config set operation."""
        result = self.run_config_command('set', 'test.new', '"test_value"')
        self.assertIn("Set test.new to \"test_value\"", result.stdout)

        # Verify the value was set in db config
        db_config = self.load_config_file('db')
        self.assertEqual(db_config['test.new'], 'test_value')
        self.assertEqual(db_config['test.new.type'], 'string')  # Auto-typing

        # Verify it was NOT set in default config
        default_config = self.load_config_file('config')
        self.assertNotIn('test.new', default_config)

    def test_config_set_with_default_flag(self):
        """Test config set with --default flag."""
        result = self.run_config_command('set', 'test.both', '"dual_value"', '--default')
        self.assertIn("Set test.both to \"dual_value\" in db and default config", result.stdout)

        # Verify the value was set in both configs
        db_config = self.load_config_file('db')
        default_config = self.load_config_file('config')

        self.assertEqual(db_config['test.both'], 'dual_value')
        self.assertEqual(default_config['test.both'], 'dual_value')
        self.assertEqual(db_config['test.both.type'], 'string')
        self.assertEqual(default_config['test.both.type'], 'string')

    def test_config_set_different_json_types(self):
        """Test setting different JSON data types."""
        test_cases = [
            ('string.key', '"string_value"', 'string_value', 'string'),
            ('number.key', '42', 42, 'number'),
            ('boolean.key', 'true', True, 'boolean'),
            ('array.key', '[1, 2, 3]', [1, 2, 3], 'array'),
            ('object.key', '{"nested": "value"}', {"nested": "value"}, 'object'),
            ('null.key', 'null', None, 'null')
        ]

        for key, json_value, expected_value, expected_type in test_cases:
            with self.subTest(key=key):
                result = self.run_config_command('set', key, json_value)
                self.assertIn(f"Set {key} to", result.stdout)

                db_config = self.load_config_file('db')
                self.assertEqual(db_config[key], expected_value)
                self.assertEqual(db_config[f"{key}.type"], expected_type)

    def test_config_set_values_constraint(self):
        """Test setting values constraint using --values flag."""
        result = self.run_config_command('set', 'new.constrained', '--values', '["option1", "option2", "option3"]')
        self.assertIn("Set new.constrained.values to ['option1', 'option2', 'option3']", result.stdout)

        db_config = self.load_config_file('db')
        self.assertEqual(db_config['new.constrained.values'], ["option1", "option2", "option3"])

    def test_config_set_type_constraint(self):
        """Test setting type constraint using --type flag."""
        result = self.run_config_command('set', 'new.typed', '--type', 'number')
        self.assertIn("Set new.typed.type to number", result.stdout)

        db_config = self.load_config_file('db')
        self.assertEqual(db_config['new.typed.type'], "number")

    def test_config_set_constraint_validation_values(self):
        """Test that values constraint validation works."""
        # Try to set an invalid value
        result = self.run_config_command('set', 'constrained.setting', '"invalid"', expect_success=False)
        self.assertIn("Error: Value does not meet validation constraints", result.stdout)

        # Set a valid value
        result = self.run_config_command('set', 'constrained.setting', '"option2"')
        self.assertIn("Set constrained.setting to \"option2\"", result.stdout)

    def test_config_set_constraint_validation_type(self):
        """Test that type constraint validation works."""
        # Try to set wrong type (session.timeout expects number)
        result = self.run_config_command('set', 'session.timeout', '"not_a_number"', expect_success=False)
        self.assertIn("Error: Value does not meet validation constraints", result.stdout)

        # Set correct type
        result = self.run_config_command('set', 'session.timeout', '7200')
        self.assertIn("Set session.timeout to 7200", result.stdout)

    def test_config_set_invalid_json(self):
        """Test setting invalid JSON value."""
        result = self.run_config_command('set', 'test.key', 'invalid_json', expect_success=False)
        self.assertIn("Error: Value must be valid JSON", result.stdout)

    def test_config_set_missing_value(self):
        """Test setting without providing value, --values, or --type."""
        result = self.run_config_command('set', 'test.key', expect_success=False)
        self.assertIn("Error: Value is required when not using --values or --type", result.stdout)

    def test_config_delete_basic(self):
        """Test basic config delete operation."""
        result = self.run_config_command('delete', 'test.array')
        self.assertIn("Deleted key 'test.array'", result.stdout)

        # Verify key was deleted from db config
        db_config = self.load_config_file('db')
        self.assertNotIn('test.array', db_config)

        # Verify heartbeat.interval exists in both configs (different values)
        default_config = self.load_config_file('config')
        self.assertIn('heartbeat.interval', default_config)

    def test_config_delete_with_default_flag(self):
        """Test config delete with --default flag."""
        result = self.run_config_command('delete', 'heartbeat.interval', '--default')
        self.assertIn("Deleted key 'heartbeat.interval' from db config and default config", result.stdout)

        # Verify key was deleted from both configs
        db_config = self.load_config_file('db')
        default_config = self.load_config_file('config')

        self.assertNotIn('heartbeat.interval', db_config)
        self.assertNotIn('heartbeat.interval', default_config)

    def test_config_delete_partial_existence(self):
        """Test deleting key that exists in only one config file."""
        # Key only exists in default config
        result = self.run_config_command('delete', 'default.only.setting', '--default')

        self.assertIn("Deleted key 'default.only.setting' from default config", result.stdout)
        self.assertIn("Key 'default.only.setting' not found in db config", result.stdout)

    def test_config_delete_nonexistent_key(self):
        """Test deleting a nonexistent key."""
        result = self.run_config_command('delete', 'nonexistent.key')
        self.assertIn("Key 'nonexistent.key' not found", result.stdout)

    def test_config_roundtrip_operations(self):
        """Test a complete roundtrip: set, get, modify, delete."""
        # Set initial value
        self.run_config_command('set', 'roundtrip.key', '"initial_value"')

        # Get the value
        result = self.run_config_command('get', 'roundtrip.key')
        self.assertEqual(result.stdout.strip(), '"initial_value"')

        # Modify the value
        self.run_config_command('set', 'roundtrip.key', '"modified_value"')

        # Get the modified value
        result = self.run_config_command('get', 'roundtrip.key')
        self.assertEqual(result.stdout.strip(), '"modified_value"')

        # Delete the key
        self.run_config_command('delete', 'roundtrip.key')

        # Verify it's gone
        result = self.run_config_command('get', 'roundtrip.key', expect_success=False)
        self.assertIn("Error: Key 'roundtrip.key' not found", result.stdout)

    def test_config_complex_keys_and_values(self):
        """Test with complex key names and values."""
        complex_cases = [
            ('complex.nested.key.name', '{"deeply": {"nested": {"value": true}}}'),
            ('key.with.dots.and.underscores_mixed', '[1, "two", 3.14, null, true]'),
            ('unicode.test', '"测试 unicode 🌟"'),
            ('empty.containers', '{"empty_object": {}, "empty_array": []}')
        ]

        for key, json_value in complex_cases:
            with self.subTest(key=key):
                # Set with --default to test both files
                result = self.run_config_command('set', key, json_value, '--default')
                self.assertIn(f"Set {key} to", result.stdout)

                # Verify in both configs
                result = self.run_config_command('get', key)
                expected_value = json.loads(json_value)
                actual_value = json.loads(result.stdout.strip())
                self.assertEqual(actual_value, expected_value)

                result = self.run_config_command('get', key, '--default')
                actual_value = json.loads(result.stdout.strip())
                self.assertEqual(actual_value, expected_value)

    def test_config_help_commands(self):
        """Test that help commands work properly."""
        # Main config help
        result = subprocess.run([
            'uv', 'run', 'python', str(self.manage_py),
            'config', '--help'
        ], capture_output=True, text=True, env=os.environ.copy())
        self.assertEqual(result.returncode, 0)
        self.assertIn("config management", result.stdout.lower())

        # Subcommand help
        for subcmd in ['get', 'set', 'delete']:
            result = subprocess.run([
                'uv', 'run', 'python', str(self.manage_py),
                'config', subcmd, '--help'
            ], capture_output=True, text=True, env=os.environ.copy())
            self.assertEqual(result.returncode, 0)
            self.assertIn(subcmd, result.stdout.lower())

    def test_auto_typing_behavior(self):
        """Test that auto-typing works correctly for new keys."""
        type_cases = [
            ('auto.string', '"string"', 'string'),
            ('auto.number.int', '42', 'number'),
            ('auto.number.float', '3.14', 'number'),
            ('auto.boolean.true', 'true', 'boolean'),
            ('auto.boolean.false', 'false', 'boolean'),
            ('auto.array', '[1, 2, 3]', 'array'),
            ('auto.object', '{"key": "value"}', 'object'),
            ('auto.null', 'null', 'null')
        ]

        for key, json_value, expected_type in type_cases:
            with self.subTest(key=key, expected_type=expected_type):
                self.run_config_command('set', key, json_value)

                db_config = self.load_config_file('db')
                self.assertEqual(db_config[f'{key}.type'], expected_type)

    def test_special_keys_validation(self):
        """Test validation for special .values and .type keys."""
        # Test that .values keys must be arrays
        result = self.run_config_command('set', 'test.values', '"not_an_array"', expect_success=False)
        self.assertIn("Error: Values keys must be arrays", result.stdout)

        # Test valid .values key
        self.run_config_command('set', 'test.values', '["valid", "array"]')

        # Test that .type keys must be valid JSON types
        result = self.run_config_command('set', 'test.type', '"invalid_type"', expect_success=False)
        self.assertIn("Error: Type must be one of", result.stdout)

        # Test valid .type key
        self.run_config_command('set', 'test.type', '"string"')


def run_tests():
    """Run the tests when this file is executed directly."""
    unittest.main(verbosity=2)


if __name__ == '__main__':
    run_tests()