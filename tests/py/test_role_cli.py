#!/usr/bin/env python3
"""
@testCovers bin/manage.py
@testCovers server/lib/role_utils.py

Integration tests for role-related CLI functionality in manage.py.

Tests role validation and listing functionality including:
- Role validation during user role assignment/removal
- Available roles listing when invalid roles are provided
- Role file loading and validation
- Error handling for missing or malformed roles file
- Integration with user management commands
"""

import unittest
import tempfile
import json
import subprocess
import shutil
import os
from pathlib import Path


class TestRoleCLI(unittest.TestCase):
    """Integration tests for role-related CLI functionality."""

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

    def run_user_command(self, *args, expect_success=True):
        """Run a user command and return the result."""
        cmd = [
            'uv', 'run', 'python', str(self.manage_py),
            'user'
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

    def load_roles_file(self):
        """Load the roles.json file and return the parsed JSON."""
        roles_file = self.temp_db_dir / 'roles.json'
        if not roles_file.exists():
            raise RuntimeError("Roles file does not exist")
        return json.loads(roles_file.read_text())

    def modify_roles_file(self, roles_data):
        """Modify the roles.json file with new data."""
        roles_file = self.temp_db_dir / 'roles.json'
        roles_file.write_text(json.dumps(roles_data, indent=2))

    def delete_roles_file(self):
        """Delete the roles.json file."""
        roles_file = self.temp_db_dir / 'roles.json'
        if roles_file.exists():
            roles_file.unlink()

    def test_role_validation_valid_roles(self):
        """Test that all default roles can be assigned successfully."""
        roles = self.load_roles_file()
        role_ids = [role['id'] for role in roles]

        for role_id in role_ids:
            with self.subTest(role=role_id):
                # First try to remove the role in case user already has it
                self.run_user_command('remove-role', 'testuser1', role_id, expect_success=False)

                # Now add the role
                result = self.run_user_command('add-role', 'testuser1', role_id)
                self.assertIn(f"Role '{role_id}' added to user 'testuser1'", result.stdout)

                # Remove the role for next iteration
                self.run_user_command('remove-role', 'testuser1', role_id)

    def test_role_validation_invalid_role(self):
        """Test that invalid roles are rejected with helpful error."""
        result = self.run_user_command('add-role', 'testuser1', 'invalidrole', expect_success=False)

        self.assertIn("Role 'invalidrole' is not a valid role", result.stdout)
        self.assertIn("Available roles:", result.stdout)

        # Verify all available roles are listed
        roles = self.load_roles_file()
        for role in roles:
            role_id = role['id']
            role_name = role['roleName']
            description = role.get('description', '')
            if description:
                expected_line = f"{role_id} ({role_name}: {description})"
            else:
                expected_line = f"{role_id}: {role_name}"
            self.assertIn(expected_line, result.stdout)

    def test_role_listing_on_empty_role_argument(self):
        """Test that available roles are listed when no role is provided."""
        # Test with add-role
        result = self.run_user_command('add-role', 'testuser1')
        self.assertIn("Available roles:", result.stdout)

        roles = self.load_roles_file()
        for role in roles:
            role_id = role['id']
            role_name = role['roleName']
            description = role.get('description', '')
            if description:
                expected_line = f"{role_id} ({role_name}: {description})"
            else:
                expected_line = f"{role_id}: {role_name}"
            self.assertIn(expected_line, result.stdout)

        # Test with remove-role
        result = self.run_user_command('remove-role', 'testuser1')
        self.assertIn("Available roles:", result.stdout)

    def test_role_validation_case_sensitivity(self):
        """Test that role validation is case sensitive."""
        result = self.run_user_command('add-role', 'testuser1', 'ADMIN', expect_success=False)
        self.assertIn("Role 'ADMIN' is not a valid role", result.stdout)

        result = self.run_user_command('add-role', 'testuser1', 'Admin', expect_success=False)
        self.assertIn("Role 'Admin' is not a valid role", result.stdout)

        # But lowercase admin should work
        result = self.run_user_command('add-role', 'testuser1', 'admin')
        self.assertIn("Role 'admin' added to user 'testuser1'", result.stdout)

    def test_role_validation_with_missing_roles_file(self):
        """Test behavior when roles.json file is missing."""
        self.delete_roles_file()

        result = self.run_user_command('add-role', 'testuser1', 'admin', expect_success=False)
        self.assertIn("Error: Roles file not found", result.stdout)

    def test_role_validation_with_malformed_roles_file(self):
        """Test behavior when roles.json file is malformed."""
        # Write invalid JSON
        roles_file = self.temp_db_dir / 'roles.json'
        roles_file.write_text('{"invalid": json}')

        result = self.run_user_command('add-role', 'testuser1', 'admin', expect_success=False)
        self.assertIn("Error: Invalid JSON", result.stdout)

    def test_role_validation_with_invalid_roles_structure(self):
        """Test behavior when roles.json has invalid structure."""
        # Write roles as object instead of array
        self.modify_roles_file({"admin": "Administrator"})

        result = self.run_user_command('add-role', 'testuser1', 'admin', expect_success=False)
        self.assertIn("Error: Invalid roles file format", result.stdout)

    def test_role_validation_with_incomplete_role_objects(self):
        """Test behavior with roles missing required fields."""
        # Role without 'id' field
        incomplete_roles = [
            {"roleName": "Administrator"},  # Missing 'id'
            {"id": "user", "roleName": "User"},  # Valid role
            {"id": "annotator"}  # Missing 'roleName' (should still work)
        ]
        self.modify_roles_file(incomplete_roles)

        # Should still be able to use valid roles
        # First remove existing role if present
        self.run_user_command('remove-role', 'testuser1', 'user', expect_success=False)
        result = self.run_user_command('add-role', 'testuser1', 'user')
        self.assertIn("Role 'user' added to user 'testuser1'", result.stdout)

        result = self.run_user_command('add-role', 'testuser1', 'annotator')
        self.assertIn("Role 'annotator' added to user 'testuser1'", result.stdout)

        # Invalid role should still be rejected
        result = self.run_user_command('add-role', 'testuser1', 'admin', expect_success=False)
        self.assertIn("Role 'admin' is not a valid role", result.stdout)

    def test_role_listing_format(self):
        """Test the format of role listing output."""
        result = self.run_user_command('add-role', 'testuser1')

        # Check overall format
        self.assertIn("Available roles:", result.stdout)

        roles = self.load_roles_file()
        for role in roles:
            role_id = role['id']
            role_name = role.get('roleName', 'No description')
            description = role.get('description', '')
            if description:
                expected_line = f"  {role_id} ({role_name}: {description})"
            else:
                expected_line = f"  {role_id}: {role_name}"
            self.assertIn(expected_line, result.stdout)

    def test_role_validation_during_remove_role(self):
        """Test role validation during role removal."""
        # Add a valid role first
        self.run_user_command('add-role', 'testuser1', 'admin')

        # Try to remove an invalid role
        result = self.run_user_command('remove-role', 'testuser1', 'invalidrole', expect_success=False)
        self.assertIn("Role 'invalidrole' is not a valid role", result.stdout)
        self.assertIn("Available roles:", result.stdout)

        # Remove the valid role
        result = self.run_user_command('remove-role', 'testuser1', 'admin')
        self.assertIn("Role 'admin' removed from user 'testuser1'", result.stdout)

    def test_role_validation_preserves_user_state(self):
        """Test that failed role operations don't modify user state."""
        # Get initial user state
        users_file = self.temp_db_dir / 'users.json'
        initial_content = users_file.read_text()

        # Try invalid role operation
        self.run_user_command('add-role', 'testuser1', 'invalidrole', expect_success=False)

        # Verify user file unchanged
        final_content = users_file.read_text()
        self.assertEqual(initial_content, final_content)

    def test_multiple_role_operations_with_validation(self):
        """Test multiple role operations with mixed valid/invalid roles."""
        # Start with clean user
        result = self.run_user_command('remove-role', 'testadmin', 'admin')  # Remove existing admin role

        # Add valid roles
        self.run_user_command('add-role', 'testadmin', 'admin')
        self.run_user_command('add-role', 'testadmin', 'annotator')

        # Try to add invalid role - should fail but not affect existing roles
        self.run_user_command('add-role', 'testadmin', 'invalidrole', expect_success=False)

        # Verify existing roles still intact
        users_file = self.temp_db_dir / 'users.json'
        users = json.loads(users_file.read_text())
        user = next((u for u in users if u['username'] == 'testadmin'), None)
        self.assertIn('admin', user['roles'])
        self.assertIn('annotator', user['roles'])
        self.assertIn('user', user['roles'])  # Original role

        # Remove valid role
        result = self.run_user_command('remove-role', 'testadmin', 'annotator')
        self.assertIn("Role 'annotator' removed", result.stdout)

        # Try to remove invalid role
        self.run_user_command('remove-role', 'testadmin', 'invalidrole', expect_success=False)

        # Verify admin role still intact
        users = json.loads(users_file.read_text())
        user = next((u for u in users if u['username'] == 'testadmin'), None)
        self.assertIn('admin', user['roles'])
        self.assertNotIn('annotator', user['roles'])

    def test_role_validation_edge_cases(self):
        """Test role validation with edge cases."""
        edge_cases = [
            ' ',  # Whitespace
            'admin ',  # Trailing space
            ' admin',  # Leading space
            'ad min',  # Space in middle
            'admin\\n',  # Newline
            'admin\\t',  # Tab
        ]

        for role in edge_cases:
            with self.subTest(role=repr(role)):
                result = self.run_user_command('add-role', 'testuser1', role, expect_success=False)
                self.assertIn("is not a valid role", result.stdout)

        # Test empty string separately as it triggers role listing
        result = self.run_user_command('add-role', 'testuser1', '')
        self.assertIn("Available roles:", result.stdout)

    def test_role_validation_unicode_roles(self):
        """Test role validation with unicode characters."""
        # Add unicode role to roles file
        roles = self.load_roles_file()
        roles.append({
            "id": "unicode_role",
            "roleName": "Unicode Test Role",
            "description": "Test role with unicode name"
        })
        self.modify_roles_file(roles)

        # Should be able to add unicode role
        result = self.run_user_command('add-role', 'testuser1', 'unicode_role')
        self.assertIn("Role 'unicode_role' added to user 'testuser1'", result.stdout)

        # Should be able to remove unicode role
        result = self.run_user_command('remove-role', 'testuser1', 'unicode_role')
        self.assertIn("Role 'unicode_role' removed from user 'testuser1'", result.stdout)

    def test_role_validation_with_special_characters(self):
        """Test role validation with special characters in role names."""
        # Add roles with special characters
        roles = self.load_roles_file()
        special_roles = [
            {"id": "role-with-dash", "roleName": "Role With Dash"},
            {"id": "role_with_underscore", "roleName": "Role With Underscore"},
            {"id": "role.with.dots", "roleName": "Role With Dots"},
            {"id": "role123", "roleName": "Role With Numbers"}
        ]
        roles.extend(special_roles)
        self.modify_roles_file(roles)

        # Test each special role
        for role_data in special_roles:
            role_id = role_data['id']
            with self.subTest(role=role_id):
                result = self.run_user_command('add-role', 'testuser1', role_id)
                self.assertIn(f"Role '{role_id}' added to user 'testuser1'", result.stdout)

                result = self.run_user_command('remove-role', 'testuser1', role_id)
                self.assertIn(f"Role '{role_id}' removed from user 'testuser1'", result.stdout)

    def test_role_listing_with_empty_roles_file(self):
        """Test role listing when roles file is empty."""
        self.modify_roles_file([])

        result = self.run_user_command('add-role', 'testuser1', 'admin', expect_success=False)
        self.assertIn("Available roles:", result.stdout)
        # With empty roles, should show the header but no roles

    def test_role_validation_performance_with_many_roles(self):
        """Test role validation performance with large number of roles."""
        # Create many roles
        many_roles = []
        for i in range(100):
            many_roles.append({
                "id": f"role{i:03d}",
                "roleName": f"Test Role {i:03d}"
            })

        # Keep some original roles
        original_roles = self.load_roles_file()
        many_roles.extend(original_roles)
        self.modify_roles_file(many_roles)

        # Should still work efficiently
        result = self.run_user_command('add-role', 'testuser1', 'role050')
        self.assertIn("Role 'role050' added to user 'testuser1'", result.stdout)

        # Invalid role should still be caught
        result = self.run_user_command('add-role', 'testuser1', 'role999', expect_success=False)
        self.assertIn("Role 'role999' is not a valid role", result.stdout)


def run_tests():
    """Run the tests when this file is executed directly."""
    unittest.main(verbosity=2)


if __name__ == '__main__':
    run_tests()