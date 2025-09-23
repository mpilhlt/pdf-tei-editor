#!/usr/bin/env python3
"""
@testCovers bin/manage.py

Integration tests for the user CLI commands in manage.py.

Tests all user management functionality including:
- user add/remove/list operations
- Password management and update
- Role assignment and removal
- User property updates
- Error handling and edge cases
- Role validation against available roles
"""

import unittest
import tempfile
import json
import subprocess
import shutil
import os
from pathlib import Path


class TestUserCLI(unittest.TestCase):
    """Integration tests for the user CLI commands."""

    def setUp(self):
        """Set up test environment with test data directory."""
        # Use test data directory
        self.test_data_dir = Path(__file__).parent / 'data'
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

    def run_user_command(self, *args, expect_success=True, input_text=None):
        """Run a user command and return the result."""
        cmd = [
            'uv', 'run', 'python', str(self.manage_py),
            'user'
        ] + list(args)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            env=os.environ.copy(),
            input=input_text
        )

        if expect_success and result.returncode != 0:
            self.fail(f"Command failed: {' '.join(cmd)}\\nStdout: {result.stdout}\\nStderr: {result.stderr}")

        return result

    def load_users_file(self):
        """Load the users.json file and return the parsed JSON."""
        users_file = self.temp_db_dir / 'users.json'
        if not users_file.exists():
            raise RuntimeError("Users file does not exist")
        return json.loads(users_file.read_text())

    def load_roles_file(self):
        """Load the roles.json file and return the parsed JSON."""
        roles_file = self.temp_db_dir / 'roles.json'
        if not roles_file.exists():
            raise RuntimeError("Roles file does not exist")
        return json.loads(roles_file.read_text())

    def test_user_list_existing_users(self):
        """Test listing existing users from test data."""
        result = self.run_user_command('list')

        # Check that all test users are listed
        self.assertIn('testuser1', result.stdout)
        self.assertIn('testadmin', result.stdout)
        self.assertIn('testannotator', result.stdout)

        # Check formatting
        self.assertIn('Test User One (testuser1)', result.stdout)
        self.assertIn('Test Administrator (testadmin)', result.stdout)
        self.assertIn('Test Annotator (testannotator)', result.stdout)

    def test_user_add_basic(self):
        """Test adding a new user with basic information."""
        result = self.run_user_command('add', 'newuser', '--password', 'testpass123',
                                     '--fullname', 'New Test User', '--email', 'new@example.com')

        self.assertIn("User 'newuser' added successfully", result.stdout)

        # Verify user was added to file
        users = self.load_users_file()
        new_user = next((u for u in users if u['username'] == 'newuser'), None)
        self.assertIsNotNone(new_user)
        self.assertEqual(new_user['fullname'], 'New Test User')
        self.assertEqual(new_user['email'], 'new@example.com')
        self.assertEqual(new_user['roles'], ['user'])
        self.assertIsNotNone(new_user['passwd_hash'])

    def test_user_add_minimal(self):
        """Test adding a user with minimal information."""
        result = self.run_user_command('add', 'minimaluser', '--password', 'testpass123')

        self.assertIn("User 'minimaluser' added successfully", result.stdout)

        # Verify user was added with defaults
        users = self.load_users_file()
        new_user = next((u for u in users if u['username'] == 'minimaluser'), None)
        self.assertIsNotNone(new_user)
        self.assertEqual(new_user['fullname'], '')
        self.assertEqual(new_user['email'], '')
        self.assertEqual(new_user['roles'], ['user'])

    def test_user_add_duplicate_username(self):
        """Test adding a user with an existing username."""
        result = self.run_user_command('add', 'testuser1', '--password', 'testpass123',
                                     expect_success=False)

        self.assertIn("User 'testuser1' already exists", result.stdout)

    def test_user_add_interactive_password(self):
        """Test adding a user with interactive password input."""
        result = self.run_user_command('add', 'interactive_user', '--fullname', 'Interactive User',
                                     input_text='secretpass\\nsecretpass\\n')

        self.assertIn("User 'interactive_user' added successfully", result.stdout)

        # Verify user was added
        users = self.load_users_file()
        new_user = next((u for u in users if u['username'] == 'interactive_user'), None)
        self.assertIsNotNone(new_user)

    def test_user_add_password_mismatch(self):
        """Test adding a user with mismatched password confirmation."""
        result = self.run_user_command('add', 'mismatch_user', '--fullname', 'Mismatch User',
                                     input_text='password1\\npassword2\\n', expect_success=False)

        self.assertIn("Passwords do not match", result.stdout)

    def test_user_remove_existing(self):
        """Test removing an existing user."""
        result = self.run_user_command('remove', 'testuser1')

        self.assertIn("User 'testuser1' removed successfully", result.stdout)

        # Verify user was removed
        users = self.load_users_file()
        removed_user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertIsNone(removed_user)

    def test_user_remove_nonexistent(self):
        """Test removing a non-existent user."""
        result = self.run_user_command('remove', 'nonexistent', expect_success=False)

        self.assertIn("User 'nonexistent' not found", result.stdout)

    def test_user_update_password(self):
        """Test updating a user's password."""
        result = self.run_user_command('update-password', 'testuser1', 'newpassword123')

        self.assertIn("Password for user 'testuser1' updated successfully", result.stdout)

        # Verify password hash changed
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertIsNotNone(user)
        # Original test user has hash for 'password', verify it changed
        self.assertNotEqual(user['passwd_hash'], '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8')

    def test_user_update_password_interactive(self):
        """Test updating a user's password interactively."""
        result = self.run_user_command('update-password', 'testuser1',
                                     input_text='newpass123\\nnewpass123\\n')

        self.assertIn("Password for user 'testuser1' updated successfully", result.stdout)

    def test_user_update_password_nonexistent(self):
        """Test updating password for non-existent user."""
        result = self.run_user_command('update-password', 'nonexistent', 'newpass', expect_success=False)

        self.assertIn("User 'nonexistent' not found", result.stdout)

    def test_user_set_property_fullname(self):
        """Test setting user fullname property."""
        result = self.run_user_command('set', 'testuser1', 'fullname', 'Updated Full Name')

        self.assertIn("Property 'fullname' for user 'testuser1' set to 'Updated Full Name'", result.stdout)

        # Verify property was updated
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertEqual(user['fullname'], 'Updated Full Name')

    def test_user_set_property_email(self):
        """Test setting user email property."""
        result = self.run_user_command('set', 'testuser1', 'email', 'newemail@example.com')

        self.assertIn("Property 'email' for user 'testuser1' set to 'newemail@example.com'", result.stdout)

        # Verify property was updated
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertEqual(user['email'], 'newemail@example.com')

    def test_user_set_property_username(self):
        """Test setting username property (renaming user)."""
        result = self.run_user_command('set', 'testuser1', 'username', 'renameduser')

        self.assertIn("Property 'username' for user 'testuser1' set to 'renameduser'", result.stdout)
        self.assertIn("User 'testuser1' is now 'renameduser'", result.stdout)

        # Verify username was changed
        users = self.load_users_file()
        old_user = next((u for u in users if u['username'] == 'testuser1'), None)
        new_user = next((u for u in users if u['username'] == 'renameduser'), None)
        self.assertIsNone(old_user)
        self.assertIsNotNone(new_user)

    def test_user_set_property_username_conflict(self):
        """Test setting username to an existing username."""
        result = self.run_user_command('set', 'testuser1', 'username', 'testadmin', expect_success=False)

        self.assertIn("User with username 'testadmin' already exists", result.stdout)

    def test_user_set_property_nonexistent_user(self):
        """Test setting property for non-existent user."""
        result = self.run_user_command('set', 'nonexistent', 'fullname', 'New Name', expect_success=False)

        self.assertIn("User 'nonexistent' not found", result.stdout)

    def test_user_add_role_valid(self):
        """Test adding a valid role to a user."""
        result = self.run_user_command('add-role', 'testuser1', 'admin')

        self.assertIn("Role 'admin' added to user 'testuser1'", result.stdout)

        # Verify role was added
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertIn('admin', user['roles'])

    def test_user_add_role_duplicate(self):
        """Test adding a role that user already has."""
        result = self.run_user_command('add-role', 'testadmin', 'admin', expect_success=False)

        self.assertIn("User 'testadmin' already has the role 'admin'", result.stdout)

    def test_user_add_role_invalid(self):
        """Test adding an invalid role."""
        result = self.run_user_command('add-role', 'testuser1', 'invalidrole', expect_success=False)

        self.assertIn("Role 'invalidrole' is not a valid role", result.stdout)
        self.assertIn("Available roles:", result.stdout)

    def test_user_add_role_list_available(self):
        """Test listing available roles when no role provided."""
        result = self.run_user_command('add-role', 'testuser1')

        self.assertIn("Available roles:", result.stdout)
        self.assertIn("admin (Administrator: Application management, user configuration)", result.stdout)
        self.assertIn("user (User: Application usage that requires no special authorization)", result.stdout)
        self.assertIn("annotator (Annotator: Document annotation, subject to review)", result.stdout)
        self.assertIn("reviewer (Reviewer: Reviewing of anotated documents, gold file management)", result.stdout)
        self.assertIn("editor (Editor: Document editing and content management)", result.stdout)

    def test_user_add_role_nonexistent_user(self):
        """Test adding role to non-existent user."""
        result = self.run_user_command('add-role', 'nonexistent', 'user', expect_success=False)

        self.assertIn("User 'nonexistent' not found", result.stdout)

    def test_user_remove_role_valid(self):
        """Test removing a role from a user."""
        result = self.run_user_command('remove-role', 'testadmin', 'admin')

        self.assertIn("Role 'admin' removed from user 'testadmin'", result.stdout)

        # Verify role was removed
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testadmin'), None)
        self.assertNotIn('admin', user['roles'])

    def test_user_remove_role_not_assigned(self):
        """Test removing a role that user doesn't have."""
        result = self.run_user_command('remove-role', 'testuser1', 'admin', expect_success=False)

        self.assertIn("User 'testuser1' does not have the role 'admin'", result.stdout)

    def test_user_remove_role_invalid(self):
        """Test removing an invalid role."""
        result = self.run_user_command('remove-role', 'testuser1', 'invalidrole', expect_success=False)

        self.assertIn("Role 'invalidrole' is not a valid role", result.stdout)
        self.assertIn("Available roles:", result.stdout)

    def test_user_remove_role_list_available(self):
        """Test listing available roles when no role provided for removal."""
        result = self.run_user_command('remove-role', 'testuser1')

        self.assertIn("Available roles:", result.stdout)

    def test_user_remove_role_nonexistent_user(self):
        """Test removing role from non-existent user."""
        result = self.run_user_command('remove-role', 'nonexistent', 'user', expect_success=False)

        self.assertIn("User 'nonexistent' not found", result.stdout)

    def test_user_role_workflow(self):
        """Test complete role management workflow."""
        # Start with testuser1 who has only 'user' role
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertEqual(user['roles'], ['user'])

        # Add annotator role
        result = self.run_user_command('add-role', 'testuser1', 'annotator')
        self.assertIn("Role 'annotator' added", result.stdout)

        # Add reviewer role
        result = self.run_user_command('add-role', 'testuser1', 'reviewer')
        self.assertIn("Role 'reviewer' added", result.stdout)

        # Verify both roles added
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertIn('annotator', user['roles'])
        self.assertIn('reviewer', user['roles'])
        self.assertIn('user', user['roles'])  # Original role preserved

        # Remove annotator role
        result = self.run_user_command('remove-role', 'testuser1', 'annotator')
        self.assertIn("Role 'annotator' removed", result.stdout)

        # Verify annotator removed but others remain
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'testuser1'), None)
        self.assertNotIn('annotator', user['roles'])
        self.assertIn('reviewer', user['roles'])
        self.assertIn('user', user['roles'])

    def test_user_comprehensive_workflow(self):
        """Test comprehensive user management workflow."""
        # Add new user
        result = self.run_user_command('add', 'workflowuser', '--password', 'testpass',
                                     '--fullname', 'Workflow Test User', '--email', 'workflow@example.com')
        self.assertIn("User 'workflowuser' added successfully", result.stdout)

        # Update user properties
        self.run_user_command('set', 'workflowuser', 'fullname', 'Updated Workflow User')
        self.run_user_command('set', 'workflowuser', 'email', 'updated@example.com')

        # Add multiple roles
        self.run_user_command('add-role', 'workflowuser', 'annotator')
        self.run_user_command('add-role', 'workflowuser', 'editor')

        # Update password
        self.run_user_command('update-password', 'workflowuser', 'newpassword123')

        # Verify final state
        users = self.load_users_file()
        user = next((u for u in users if u['username'] == 'workflowuser'), None)
        self.assertIsNotNone(user)
        self.assertEqual(user['fullname'], 'Updated Workflow User')
        self.assertEqual(user['email'], 'updated@example.com')
        self.assertIn('user', user['roles'])
        self.assertIn('annotator', user['roles'])
        self.assertIn('editor', user['roles'])

        # Clean up - remove user
        result = self.run_user_command('remove', 'workflowuser')
        self.assertIn("User 'workflowuser' removed successfully", result.stdout)

    def test_user_help_commands(self):
        """Test that help commands work properly."""
        # Main user help
        result = subprocess.run([
            'uv', 'run', 'python', str(self.manage_py),
            'user', '--help'
        ], capture_output=True, text=True, env=os.environ.copy())
        self.assertEqual(result.returncode, 0)
        self.assertIn("user", result.stdout.lower())

        # Subcommand help
        for subcmd in ['add', 'remove', 'list', 'set', 'update-password', 'add-role', 'remove-role']:
            result = subprocess.run([
                'uv', 'run', 'python', str(self.manage_py),
                'user', subcmd, '--help'
            ], capture_output=True, text=True, env=os.environ.copy())
            self.assertEqual(result.returncode, 0)
            self.assertIn(subcmd, result.stdout.lower())


def run_tests():
    """Run the tests when this file is executed directly."""
    unittest.main(verbosity=2)


if __name__ == '__main__':
    run_tests()