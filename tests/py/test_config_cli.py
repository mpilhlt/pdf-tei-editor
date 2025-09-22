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
from pathlib import Path


class TestConfigCLI(unittest.TestCase):
    """Integration tests for the config CLI commands."""

    def setUp(self):
        """Set up test environment with temporary directories."""
        self.test_root = tempfile.mkdtemp()
        self.db_dir = Path(self.test_root) / 'db'
        self.config_dir = Path(self.test_root) / 'config'
        self.db_dir.mkdir(parents=True)
        self.config_dir.mkdir(parents=True)

        # Create initial config files
        self.db_config_file = self.db_dir / 'config.json'
        self.default_config_file = self.config_dir / 'config.json'

        # Initial db config
        self.db_config_file.write_text(json.dumps({
            "existing.key": "db_value",
            "heartbeat.interval": 10,
            "application.mode": "development",
            "application.mode.values": ["development", "production"],
            "constrained.key": "valid1",
            "constrained.key.values": ["valid1", "valid2"],
            "typed.key": "string_value",
            "typed.key.type": "string"
        }, indent=2))

        # Initial default config
        self.default_config_file.write_text(json.dumps({
            "existing.key": "default_value",
            "heartbeat.interval": 30,
            "default.only": "default_only_value"
        }, indent=2))

        # Path to manage.py script
        self.manage_py = Path(__file__).parent.parent.parent / 'bin' / 'manage.py'

    def tearDown(self):
        """Clean up test environment."""
        shutil.rmtree(self.test_root)

    def run_config_command(self, *args, expect_success=True):
        """Run a config command and return the result."""
        cmd = [
            'uv', 'run', 'python', str(self.manage_py),
            '--db-path', str(self.db_dir),
            '--config-path', str(self.config_dir),
            'config'
        ] + list(args)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True
        )

        if expect_success and result.returncode != 0:
            self.fail(f"Command failed: {' '.join(cmd)}\\nStdout: {result.stdout}\\nStderr: {result.stderr}")

        return result

    def load_config_file(self, config_file):
        """Load a config file and return the parsed JSON."""
        if not config_file.exists():
            return None
        return json.loads(config_file.read_text())

    def test_config_get_db_default(self):
        """Test config get command reading from db config."""
        result = self.run_config_command('get', 'heartbeat.interval')
        self.assertEqual(result.stdout.strip(), '10')

    def test_config_get_default_flag(self):
        """Test config get command with --default flag."""
        result = self.run_config_command('get', 'heartbeat.interval', '--default')
        self.assertEqual(result.stdout.strip(), '30')

    def test_config_get_default_only_key(self):
        """Test getting a key that only exists in default config."""
        result = self.run_config_command('get', 'default.only', '--default')
        self.assertEqual(result.stdout.strip(), '"default_only_value"')

    def test_config_get_nonexistent_key(self):
        """Test getting a nonexistent key."""
        result = self.run_config_command('get', 'nonexistent.key', expect_success=False)
        self.assertIn("Error: Key 'nonexistent.key' not found", result.stdout)

    def test_config_set_basic(self):
        """Test basic config set operation."""
        result = self.run_config_command('set', 'test.new', '"test_value"')
        self.assertIn("Set test.new to \"test_value\"", result.stdout)

        # Verify the value was set in db config
        db_config = self.load_config_file(self.db_config_file)
        self.assertEqual(db_config['test.new'], 'test_value')
        self.assertEqual(db_config['test.new.type'], 'string')  # Auto-typing

        # Verify it was NOT set in default config
        default_config = self.load_config_file(self.default_config_file)
        self.assertNotIn('test.new', default_config)

    def test_config_set_with_default_flag(self):
        """Test config set with --default flag."""
        result = self.run_config_command('set', 'test.both', '"dual_value"', '--default')
        self.assertIn("Set test.both to \"dual_value\" in db and default config", result.stdout)

        # Verify the value was set in both configs
        db_config = self.load_config_file(self.db_config_file)
        default_config = self.load_config_file(self.default_config_file)

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

                db_config = self.load_config_file(self.db_config_file)
                self.assertEqual(db_config[key], expected_value)
                self.assertEqual(db_config[f"{key}.type"], expected_type)

    def test_config_set_values_constraint(self):
        """Test setting values constraint using --values flag."""
        result = self.run_config_command('set', 'new.constrained', '--values', '["option1", "option2", "option3"]')
        self.assertIn("Set new.constrained.values to ['option1', 'option2', 'option3']", result.stdout)

        db_config = self.load_config_file(self.db_config_file)
        self.assertEqual(db_config['new.constrained.values'], ["option1", "option2", "option3"])

    def test_config_set_type_constraint(self):
        """Test setting type constraint using --type flag."""
        result = self.run_config_command('set', 'new.typed', '--type', 'number')
        self.assertIn("Set new.typed.type to number", result.stdout)

        db_config = self.load_config_file(self.db_config_file)
        self.assertEqual(db_config['new.typed.type'], "number")

    def test_config_set_constraint_validation_values(self):
        """Test that values constraint validation works."""
        # Try to set an invalid value
        result = self.run_config_command('set', 'constrained.key', '"invalid"', expect_success=False)
        self.assertIn("Error: Value must be one of", result.stdout)

        # Set a valid value
        result = self.run_config_command('set', 'constrained.key', '"valid2"')
        self.assertIn("Set constrained.key to \"valid2\"", result.stdout)

    def test_config_set_constraint_validation_type(self):
        """Test that type constraint validation works."""
        # Try to set wrong type
        result = self.run_config_command('set', 'typed.key', '123', expect_success=False)
        self.assertIn("Error: Value must be of type string", result.stdout)

        # Set correct type
        result = self.run_config_command('set', 'typed.key', '"valid_string"')
        self.assertIn("Set typed.key to \"valid_string\"", result.stdout)

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
        result = self.run_config_command('delete', 'existing.key')
        self.assertIn("Deleted key 'existing.key'", result.stdout)

        # Verify key was deleted from db config
        db_config = self.load_config_file(self.db_config_file)
        self.assertNotIn('existing.key', db_config)

        # Verify key still exists in default config
        default_config = self.load_config_file(self.default_config_file)
        self.assertIn('existing.key', default_config)

    def test_config_delete_with_default_flag(self):
        """Test config delete with --default flag."""
        result = self.run_config_command('delete', 'existing.key', '--default')
        self.assertIn("Deleted key 'existing.key' from db config and default config", result.stdout)

        # Verify key was deleted from both configs
        db_config = self.load_config_file(self.db_config_file)
        default_config = self.load_config_file(self.default_config_file)

        self.assertNotIn('existing.key', db_config)
        self.assertNotIn('existing.key', default_config)

    def test_config_delete_partial_existence(self):
        """Test deleting key that exists in only one config file."""
        # Key only exists in default config
        result = self.run_config_command('delete', 'default.only', '--default')

        self.assertIn("Deleted key 'default.only' from default config", result.stdout)
        self.assertIn("Key 'default.only' not found in db config", result.stdout)

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
            '--db-path', str(self.db_dir),
            '--config-path', str(self.config_dir),
            'config', '--help'
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("config management", result.stdout.lower())

        # Subcommand help
        for subcmd in ['get', 'set', 'delete']:
            result = subprocess.run([
                'uv', 'run', 'python', str(self.manage_py),
                '--db-path', str(self.db_dir),
                '--config-path', str(self.config_dir),
                'config', subcmd, '--help'
            ], capture_output=True, text=True)
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

                db_config = self.load_config_file(self.db_config_file)
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