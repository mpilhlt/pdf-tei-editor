#!/usr/bin/env node

/**
 * Remote management CLI for PDF-TEI-Editor.
 *
 * Provides user, group, collection, role, and config management via the HTTP API.
 *
 * Usage:
 *   node bin/manage-remote.js [options] <command> <subcommand> [args]
 *
 * Global Options:
 *   --env <path>          Path to .env file (default: ./.env)
 *   --user <username>     Username for authentication (default: from .env API_USER)
 *   --password <password> Password for authentication (default: from .env API_PASSWORD)
 *   --base-url <url>      API base URL (default: from .env API_BASE_URL or http://localhost:8000)
 *
 * Commands:
 *   user        Manage users
 *   group       Manage groups
 *   collection  Manage collections
 *   role        List roles
 *   config      Manage configuration
 *   diagnostic  Diagnostic utilities
 *   maintenance Maintenance mode controls (spinner, reload, repopulate)
 */

import { Command } from 'commander';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { createInterface } from 'readline';
import dotenv from 'dotenv';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Hash password using SHA-256 (matching frontend authentication)
 * @param {string} password - Plain text password
 * @returns {string} - Hex hash
 */
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

/**
 * Prompt for password interactively
 * @param {string} prompt - Prompt message
 * @returns {Promise<string>} - Password entered by user
 */
async function promptPassword(prompt = 'Password: ') {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    // Hide input by replacing with asterisks
    process.stdout.write(prompt);
    let password = '';

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (char) => {
      if (char === '\n' || char === '\r') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        console.log('');
        resolve(password);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.exit();
      } else if (char === '\u007F' || char === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        password += char;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Login to the API and get session ID
 * @param {string} baseUrl - API base URL
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Session ID
 */
async function login(baseUrl, username, password) {
  const passwdHash = hashPassword(password);

  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, passwd_hash: passwdHash }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.sessionId;
}

/**
 * Make an authenticated API request
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {object|null} body - Request body
 * @returns {Promise<object>} - Response data
 */
async function apiRequest(baseUrl, sessionId, method, path, body = null) {
  const options = {
    method,
    headers: {
      'X-Session-ID': sessionId,
    },
  };

  if (body !== null) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${path}`, options);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`${response.status} ${error}`);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Initialize environment and get credentials
 * @param {object} options - Command options with env, user, password, baseUrl
 * @returns {{baseUrl: string, username: string, password: string}}
 */
function initEnv(options) {
  const envFile = resolve(options.env || './.env');
  const envConfig = dotenv.config({ path: envFile });

  if (envConfig.error && options.env && options.env !== './.env') {
    console.error(`Failed to load environment from ${envFile}`);
    throw envConfig.error;
  }

  const username = options.user || process.env.API_USER;
  const password = options.password || process.env.API_PASSWORD;
  const baseUrl = options.baseUrl || process.env.API_BASE_URL || 'http://localhost:8000';

  return { baseUrl, username, password };
}

/**
 * Run an authenticated command
 * @param {object} options - Command options
 * @param {function} action - Async function(baseUrl, sessionId) to execute
 */
async function runAuthenticated(options, action) {
  try {
    const { baseUrl, username, password } = initEnv(options);

    if (!username) {
      throw new Error('Username required. Use --user or set API_USER in .env');
    }

    let pwd = password;
    if (!pwd) {
      pwd = await promptPassword('Password: ');
    }

    const sessionId = await login(baseUrl, username, pwd);
    await action(baseUrl, sessionId);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// ============================================================================
// User Commands
// ============================================================================

/**
 * List all users
 */
async function userList(baseUrl, sessionId) {
  const users = await apiRequest(baseUrl, sessionId, 'GET', '/api/v1/users');

  if (!users || users.length === 0) {
    console.log('No users found.');
    return;
  }

  for (const user of users) {
    const fullname = user.fullname || 'N/A';
    const username = user.username;
    const email = user.email || '';
    const roles = (user.roles || []).join(', ');
    const groups = (user.groups || []).join(', ');
    const emailPart = email ? ` [${email}]` : '';
    const groupsPart = groups ? ` | Groups: ${groups}` : '';
    console.log(`${fullname} (${username})${emailPart}: ${roles}${groupsPart}`);
  }
}

/**
 * Get a specific user
 */
async function userGet(baseUrl, sessionId, username) {
  const user = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/users/${encodeURIComponent(username)}`);

  console.log(`Username: ${user.username}`);
  console.log(`Full Name: ${user.fullname || 'N/A'}`);
  console.log(`Email: ${user.email || 'N/A'}`);
  console.log(`Roles: ${(user.roles || []).join(', ') || 'none'}`);
  console.log(`Groups: ${(user.groups || []).join(', ') || 'none'}`);
}

/**
 * Add a new user
 */
async function userAdd(baseUrl, sessionId, username, cmdOptions) {
  let password = cmdOptions.password;
  if (!password) {
    password = await promptPassword('Enter password for new user: ');
    const confirm = await promptPassword('Confirm password: ');
    if (password !== confirm) {
      throw new Error('Passwords do not match');
    }
  }

  const userData = {
    username,
    password,  // Server will hash it
    fullname: cmdOptions.fullname || '',
    email: cmdOptions.email || '',
    roles: cmdOptions.roles ? cmdOptions.roles.split(',').map((r) => r.trim()) : [],
    groups: cmdOptions.groups ? cmdOptions.groups.split(',').map((g) => g.trim()) : [],
  };

  await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/users', userData);
  console.log(`User '${username}' created successfully.`);
}

/**
 * Remove a user
 */
async function userRemove(baseUrl, sessionId, username) {
  await apiRequest(baseUrl, sessionId, 'DELETE', `/api/v1/users/${encodeURIComponent(username)}`);
  console.log(`User '${username}' removed successfully.`);
}

/**
 * Update a user
 */
async function userUpdate(baseUrl, sessionId, username, cmdOptions) {
  const updates = {};

  if (cmdOptions.password) {
    updates.password = cmdOptions.password;  // Server will hash it
  }
  if (cmdOptions.fullname !== undefined) {
    updates.fullname = cmdOptions.fullname;
  }
  if (cmdOptions.email !== undefined) {
    updates.email = cmdOptions.email;
  }

  if (Object.keys(updates).length === 0) {
    console.log('No updates specified.');
    return;
  }

  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/users/${encodeURIComponent(username)}`, updates);
  console.log(`User '${username}' updated successfully.`);
}

/**
 * Add a role to a user
 */
async function userAddRole(baseUrl, sessionId, username, role) {
  const user = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/users/${encodeURIComponent(username)}`);
  const roles = user.roles || [];

  if (roles.includes(role)) {
    console.log(`User '${username}' already has role '${role}'.`);
    return;
  }

  roles.push(role);
  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/users/${encodeURIComponent(username)}`, { roles });
  console.log(`Added role '${role}' to user '${username}'.`);
}

/**
 * Remove a role from a user
 */
async function userRemoveRole(baseUrl, sessionId, username, role) {
  const user = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/users/${encodeURIComponent(username)}`);
  const roles = user.roles || [];

  if (!roles.includes(role)) {
    console.log(`User '${username}' does not have role '${role}'.`);
    return;
  }

  const newRoles = roles.filter((r) => r !== role);
  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/users/${encodeURIComponent(username)}`, { roles: newRoles });
  console.log(`Removed role '${role}' from user '${username}'.`);
}

/**
 * Add a group to a user
 */
async function userAddGroup(baseUrl, sessionId, username, group) {
  const user = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/users/${encodeURIComponent(username)}`);
  const groups = user.groups || [];

  if (groups.includes(group)) {
    console.log(`User '${username}' already in group '${group}'.`);
    return;
  }

  groups.push(group);
  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/users/${encodeURIComponent(username)}`, { groups });
  console.log(`Added user '${username}' to group '${group}'.`);
}

/**
 * Remove a group from a user
 */
async function userRemoveGroup(baseUrl, sessionId, username, group) {
  const user = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/users/${encodeURIComponent(username)}`);
  const groups = user.groups || [];

  if (!groups.includes(group)) {
    console.log(`User '${username}' is not in group '${group}'.`);
    return;
  }

  const newGroups = groups.filter((g) => g !== group);
  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/users/${encodeURIComponent(username)}`, { groups: newGroups });
  console.log(`Removed user '${username}' from group '${group}'.`);
}

// ============================================================================
// Group Commands
// ============================================================================

/**
 * List all groups
 */
async function groupList(baseUrl, sessionId) {
  const groups = await apiRequest(baseUrl, sessionId, 'GET', '/api/v1/groups');

  if (!groups || groups.length === 0) {
    console.log('No groups found.');
    return;
  }

  for (const group of groups) {
    const groupId = group.id;
    const name = group.name || '';
    const description = group.description || '';
    const collections = (group.collections || []).join(', ');
    const descPart = description ? ` (${description})` : '';
    const collectionsPart = collections ? ` [Collections: ${collections}]` : '';
    console.log(`${groupId}: ${name}${descPart}${collectionsPart}`);
  }
}

/**
 * Get a specific group
 */
async function groupGet(baseUrl, sessionId, groupId) {
  const group = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/groups/${encodeURIComponent(groupId)}`);

  console.log(`ID: ${group.id}`);
  console.log(`Name: ${group.name || 'N/A'}`);
  console.log(`Description: ${group.description || 'N/A'}`);
  console.log(`Collections: ${(group.collections || []).join(', ') || 'none'}`);
}

/**
 * Add a new group
 */
async function groupAdd(baseUrl, sessionId, groupId, name, cmdOptions) {
  const groupData = {
    id: groupId,
    name,
    description: cmdOptions.description || '',
    collections: [],
  };

  await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/groups', groupData);
  console.log(`Group '${groupId}' created successfully.`);
}

/**
 * Remove a group
 */
async function groupRemove(baseUrl, sessionId, groupId) {
  await apiRequest(baseUrl, sessionId, 'DELETE', `/api/v1/groups/${encodeURIComponent(groupId)}`);
  console.log(`Group '${groupId}' removed successfully.`);
}

/**
 * Update a group
 */
async function groupUpdate(baseUrl, sessionId, groupId, cmdOptions) {
  const updates = {};

  if (cmdOptions.name !== undefined) {
    updates.name = cmdOptions.name;
  }
  if (cmdOptions.description !== undefined) {
    updates.description = cmdOptions.description;
  }

  if (Object.keys(updates).length === 0) {
    console.log('No updates specified.');
    return;
  }

  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/groups/${encodeURIComponent(groupId)}`, updates);
  console.log(`Group '${groupId}' updated successfully.`);
}

/**
 * Add a collection to a group
 */
async function groupAddCollection(baseUrl, sessionId, groupId, collectionId) {
  const group = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/groups/${encodeURIComponent(groupId)}`);
  const collections = group.collections || [];

  if (collections.includes(collectionId)) {
    console.log(`Group '${groupId}' already has collection '${collectionId}'.`);
    return;
  }

  collections.push(collectionId);
  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/groups/${encodeURIComponent(groupId)}`, { collections });
  console.log(`Added collection '${collectionId}' to group '${groupId}'.`);
}

/**
 * Remove a collection from a group
 */
async function groupRemoveCollection(baseUrl, sessionId, groupId, collectionId) {
  const group = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/groups/${encodeURIComponent(groupId)}`);
  const collections = group.collections || [];

  if (!collections.includes(collectionId)) {
    console.log(`Group '${groupId}' does not have collection '${collectionId}'.`);
    return;
  }

  const newCollections = collections.filter((c) => c !== collectionId);
  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/groups/${encodeURIComponent(groupId)}`, {
    collections: newCollections,
  });
  console.log(`Removed collection '${collectionId}' from group '${groupId}'.`);
}

// ============================================================================
// Collection Commands
// ============================================================================

/**
 * List all collections
 */
async function collectionList(baseUrl, sessionId, cmdOptions = {}) {
  const collections = await apiRequest(baseUrl, sessionId, 'GET', '/api/v1/collections');

  if (!collections || collections.length === 0) {
    if (!cmdOptions.idsOnly) {
      console.log('No collections found.');
    }
    return;
  }

  if (cmdOptions.idsOnly) {
    for (const collection of collections) {
      console.log(collection.id);
    }
    return;
  }

  for (const collection of collections) {
    const collectionId = collection.id;
    const name = collection.name || '';
    const description = collection.description || '';
    const descPart = description ? ` (${description})` : '';
    console.log(`${collectionId}: ${name}${descPart}`);
  }
}

/**
 * Get a specific collection
 */
async function collectionGet(baseUrl, sessionId, collectionId) {
  const collection = await apiRequest(
    baseUrl,
    sessionId,
    'GET',
    `/api/v1/collections/${encodeURIComponent(collectionId)}`
  );

  console.log(`ID: ${collection.id}`);
  console.log(`Name: ${collection.name || 'N/A'}`);
  console.log(`Description: ${collection.description || 'N/A'}`);
}

/**
 * Add a new collection
 */
async function collectionAdd(baseUrl, sessionId, collectionId, name, cmdOptions) {
  const collectionData = {
    id: collectionId,
    name,
    description: cmdOptions.description || '',
  };

  await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/collections', collectionData);
  console.log(`Collection '${collectionId}' created successfully.`);
}

/**
 * Remove a collection
 */
async function collectionRemove(baseUrl, sessionId, collectionId) {
  const result = await apiRequest(
    baseUrl,
    sessionId,
    'DELETE',
    `/api/v1/collections/${encodeURIComponent(collectionId)}`
  );
  console.log(`Collection '${collectionId}' removed successfully.`);
  if (result.files_updated !== undefined) {
    console.log(`Files updated: ${result.files_updated}`);
  }
  if (result.files_deleted !== undefined) {
    console.log(`Files deleted: ${result.files_deleted}`);
  }
}

/**
 * Update a collection
 */
async function collectionUpdate(baseUrl, sessionId, collectionId, cmdOptions) {
  const updates = {};

  if (cmdOptions.name !== undefined) {
    updates.name = cmdOptions.name;
  }
  if (cmdOptions.description !== undefined) {
    updates.description = cmdOptions.description;
  }

  if (Object.keys(updates).length === 0) {
    console.log('No updates specified.');
    return;
  }

  await apiRequest(baseUrl, sessionId, 'PUT', `/api/v1/collections/${encodeURIComponent(collectionId)}`, updates);
  console.log(`Collection '${collectionId}' updated successfully.`);
}

/**
 * List files in a collection
 */
async function collectionFiles(baseUrl, sessionId, collectionId) {
  const result = await apiRequest(
    baseUrl,
    sessionId,
    'GET',
    `/api/v1/collections/${encodeURIComponent(collectionId)}/files`
  );

  const files = result.files || [];
  if (files.length === 0) {
    console.log(`No files in collection '${collectionId}'.`);
    return;
  }

  console.log(`Files in collection '${collectionId}':`);
  for (const file of files) {
    console.log(`  ${file.filename} (${file.stable_id}) [${file.file_type}]`);
  }
}

// ============================================================================
// Role Commands
// ============================================================================

/**
 * List all roles
 */
async function roleList(baseUrl, sessionId) {
  const roles = await apiRequest(baseUrl, sessionId, 'GET', '/api/v1/roles');

  if (!roles || roles.length === 0) {
    console.log('No roles found.');
    return;
  }

  console.log('Available roles:');
  for (const role of roles) {
    const roleId = role.id;
    const roleName = role.roleName || 'No description';
    const description = role.description || '';
    if (description) {
      console.log(`  ${roleId} (${roleName}: ${description})`);
    } else {
      console.log(`  ${roleId}: ${roleName}`);
    }
  }
}

/**
 * Get a specific role
 */
async function roleGet(baseUrl, sessionId, roleId) {
  const role = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/roles/${encodeURIComponent(roleId)}`);

  console.log(`ID: ${role.id}`);
  console.log(`Name: ${role.roleName || 'N/A'}`);
  console.log(`Description: ${role.description || 'N/A'}`);
}

// ============================================================================
// Config Commands
// ============================================================================

/**
 * List all config values
 */
async function configList(baseUrl, sessionId) {
  const config = await apiRequest(baseUrl, sessionId, 'GET', '/api/v1/config/list');

  if (!config || Object.keys(config).length === 0) {
    console.log('No configuration values found.');
    return;
  }

  console.log(JSON.stringify(config, null, 2));
}

/**
 * Get a specific config value
 */
async function configGet(baseUrl, sessionId, key) {
  const value = await apiRequest(baseUrl, sessionId, 'GET', `/api/v1/config/get/${encodeURIComponent(key)}`);
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Set a config value
 */
async function configSet(baseUrl, sessionId, key, jsonValue) {
  let value;
  try {
    value = JSON.parse(jsonValue);
  } catch {
    throw new Error('Value must be valid JSON');
  }

  await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/config/set', { key, value });
  console.log(`Configuration '${key}' set successfully.`);
}

// ============================================================================
// Diagnostic Commands
// ============================================================================

/**
 * Create diagnostic access users (reviewer, annotator)
 */
async function diagnosticAccessCreate(baseUrl, sessionId) {
  const diagnosticUsers = [
    { username: 'reviewer', roles: ['reviewer', 'annotator', 'user'] },
    { username: 'annotator', roles: ['annotator', 'user'] }
  ];

  for (const { username, roles } of diagnosticUsers) {
    try {
      const userData = {
        username,
        password: username,  // Password same as username, server will hash it
        fullname: username.charAt(0).toUpperCase() + username.slice(1),
        email: '',
        roles,
        groups: ['default'],
      };

      await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/users', userData);
      console.log(`Created user '${username}' with roles '${roles.join(', ')}'.`);
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log(`User '${username}' already exists.`);
      } else {
        console.error(`Failed to create user '${username}': ${error.message}`);
      }
    }
  }
}

/**
 * Remove diagnostic access users (reviewer, annotator)
 */
async function diagnosticAccessRemove(baseUrl, sessionId) {
  const diagnosticUsers = ['reviewer', 'annotator'];

  for (const username of diagnosticUsers) {
    try {
      await apiRequest(baseUrl, sessionId, 'DELETE', `/api/v1/users/${encodeURIComponent(username)}`);
      console.log(`Removed user '${username}'.`);
    } catch (error) {
      if (error.message.includes('404') || error.message.includes('not found')) {
        console.log(`User '${username}' does not exist.`);
      } else {
        console.error(`Failed to remove user '${username}': ${error.message}`);
      }
    }
  }
}

// ============================================================================
// Maintenance Commands
// ============================================================================

/**
 * Enable maintenance mode on all connected clients
 */
async function maintenanceOn(baseUrl, sessionId, message = 'System maintenance in progress, please wait...') {
  await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/maintenance/on', { message });
  console.log('Maintenance mode enabled.');
}

/**
 * Disable maintenance mode on all connected clients
 */
async function maintenanceOff(baseUrl, sessionId, message) {
  const body = message ? { message } : {};
  await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/maintenance/off', body);
  console.log('Maintenance mode disabled.');
}

/**
 * Force all connected clients to reload
 */
async function maintenanceReload(baseUrl, sessionId) {
  await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/maintenance/reload');
  console.log('Reload signal sent to all clients.');
}

/**
 * Repopulate database fields from TEI documents
 * @param {string} baseUrl - API base URL
 * @param {string} sessionId - Session ID
 * @param {string[]} fields - Fields to repopulate (empty = all)
 */
async function maintenanceRepopulate(baseUrl, sessionId, fields) {
  console.log(`Fields: ${fields.length > 0 ? fields.join(', ') : 'all'}`);
  console.log('\nRepopulating fields from TEI documents...');

  const requestBody = fields.length > 0 ? { fields } : {};

  const result = await apiRequest(baseUrl, sessionId, 'POST', '/api/v1/files/repopulate', requestBody);

  console.log('\n=== Results ===');

  for (const fieldResult of result.results) {
    console.log(`\n${fieldResult.field}:`);
    console.log(`  Total files: ${fieldResult.total}`);
    console.log(`  Updated: ${fieldResult.updated}`);
    console.log(`  Skipped (no value): ${fieldResult.skipped}`);
    console.log(`  Errors: ${fieldResult.errors}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Success: ${result.success ? 'Yes' : 'No'}`);
  console.log(`Message: ${result.message}`);

  if (!result.success) {
    process.exit(1);
  }
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command();

program
  .name('manage-remote')
  .description('Remote management CLI for PDF-TEI-Editor')
  .version('1.0.0')
  .option('--env <path>', 'Path to .env file', './.env')
  .option('--user <username>', 'Username for authentication (overrides .env API_USER)')
  .option('--password <password>', 'Password for authentication (overrides .env API_PASSWORD)')
  .option('--base-url <url>', 'API base URL (overrides .env API_BASE_URL)');

// Get global options from program
function getGlobalOptions() {
  return program.opts();
}

// --- User Commands ---
const userCmd = program.command('user').description('Manage users');

userCmd
  .command('list')
  .description('List all users')
  .action(async () => {
    await runAuthenticated(getGlobalOptions(), userList);
  });

userCmd
  .command('get <username>')
  .description('Get a specific user')
  .action(async (username) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) => userGet(baseUrl, sessionId, username));
  });

userCmd
  .command('add <username>')
  .description('Add a new user')
  .option('--password <password>', 'Password for the new user')
  .option('--fullname <name>', 'Full name of the user')
  .option('--email <email>', 'Email address')
  .option('--roles <roles>', 'Comma-separated list of roles')
  .option('--groups <groups>', 'Comma-separated list of groups')
  .action(async (username, cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      userAdd(baseUrl, sessionId, username, cmdOptions)
    );
  });

userCmd
  .command('remove <username>')
  .description('Remove a user')
  .action(async (username) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) => userRemove(baseUrl, sessionId, username));
  });

userCmd
  .command('update <username>')
  .description('Update a user')
  .option('--password <password>', 'New password')
  .option('--fullname <name>', 'New full name')
  .option('--email <email>', 'New email address')
  .action(async (username, cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      userUpdate(baseUrl, sessionId, username, cmdOptions)
    );
  });

userCmd
  .command('add-role <username> <role>')
  .description('Add a role to a user')
  .action(async (username, role) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      userAddRole(baseUrl, sessionId, username, role)
    );
  });

userCmd
  .command('remove-role <username> <role>')
  .description('Remove a role from a user')
  .action(async (username, role) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      userRemoveRole(baseUrl, sessionId, username, role)
    );
  });

userCmd
  .command('add-group <username> <group>')
  .description('Add a user to a group')
  .action(async (username, group) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      userAddGroup(baseUrl, sessionId, username, group)
    );
  });

userCmd
  .command('remove-group <username> <group>')
  .description('Remove a user from a group')
  .action(async (username, group) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      userRemoveGroup(baseUrl, sessionId, username, group)
    );
  });

// --- Group Commands ---
const groupCmd = program.command('group').description('Manage groups');

groupCmd
  .command('list')
  .description('List all groups')
  .action(async () => {
    await runAuthenticated(getGlobalOptions(), groupList);
  });

groupCmd
  .command('get <group-id>')
  .description('Get a specific group')
  .action(async (groupId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) => groupGet(baseUrl, sessionId, groupId));
  });

groupCmd
  .command('add <group-id> <name>')
  .description('Add a new group')
  .option('--description <desc>', 'Group description')
  .action(async (groupId, name, cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      groupAdd(baseUrl, sessionId, groupId, name, cmdOptions)
    );
  });

groupCmd
  .command('remove <group-id>')
  .description('Remove a group')
  .action(async (groupId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) => groupRemove(baseUrl, sessionId, groupId));
  });

groupCmd
  .command('update <group-id>')
  .description('Update a group')
  .option('--name <name>', 'New name')
  .option('--description <desc>', 'New description')
  .action(async (groupId, cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      groupUpdate(baseUrl, sessionId, groupId, cmdOptions)
    );
  });

groupCmd
  .command('add-collection <group-id> <collection-id>')
  .description('Add a collection to a group')
  .action(async (groupId, collectionId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      groupAddCollection(baseUrl, sessionId, groupId, collectionId)
    );
  });

groupCmd
  .command('remove-collection <group-id> <collection-id>')
  .description('Remove a collection from a group')
  .action(async (groupId, collectionId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      groupRemoveCollection(baseUrl, sessionId, groupId, collectionId)
    );
  });

// --- Collection Commands ---
const collectionCmd = program.command('collection').description('Manage collections');

collectionCmd
  .command('list')
  .description('List all collections')
  .option('--ids-only', 'Output only collection IDs, one per line')
  .action(async (cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      collectionList(baseUrl, sessionId, cmdOptions)
    );
  });

collectionCmd
  .command('get <collection-id>')
  .description('Get a specific collection')
  .action(async (collectionId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      collectionGet(baseUrl, sessionId, collectionId)
    );
  });

collectionCmd
  .command('add <collection-id> <name>')
  .description('Add a new collection')
  .option('--description <desc>', 'Collection description')
  .action(async (collectionId, name, cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      collectionAdd(baseUrl, sessionId, collectionId, name, cmdOptions)
    );
  });

collectionCmd
  .command('remove <collection-id>')
  .description('Remove a collection')
  .action(async (collectionId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      collectionRemove(baseUrl, sessionId, collectionId)
    );
  });

collectionCmd
  .command('update <collection-id>')
  .description('Update a collection')
  .option('--name <name>', 'New name')
  .option('--description <desc>', 'New description')
  .action(async (collectionId, cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      collectionUpdate(baseUrl, sessionId, collectionId, cmdOptions)
    );
  });

collectionCmd
  .command('files <collection-id>')
  .description('List files in a collection')
  .action(async (collectionId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      collectionFiles(baseUrl, sessionId, collectionId)
    );
  });

// --- Role Commands ---
const roleCmd = program.command('role').description('List roles (read-only)');

roleCmd
  .command('list')
  .description('List all roles')
  .action(async () => {
    await runAuthenticated(getGlobalOptions(), roleList);
  });

roleCmd
  .command('get <role-id>')
  .description('Get a specific role')
  .action(async (roleId) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) => roleGet(baseUrl, sessionId, roleId));
  });

// --- Config Commands ---
const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('list')
  .description('List all configuration values')
  .action(async () => {
    await runAuthenticated(getGlobalOptions(), configList);
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .action(async (key) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) => configGet(baseUrl, sessionId, key));
  });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value (value must be valid JSON)')
  .action(async (key, value) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) => configSet(baseUrl, sessionId, key, value));
  });

// --- Diagnostic Commands ---
const diagnosticCmd = program.command('diagnostic').description('Diagnostic utilities');

const accessCmd = diagnosticCmd.command('access').description('Manage diagnostic access users');

accessCmd
  .command('create')
  .description("Create diagnostic users 'reviewer' and 'annotator' (password = username)")
  .action(async () => {
    await runAuthenticated(getGlobalOptions(), diagnosticAccessCreate);
  });

accessCmd
  .command('remove')
  .description("Remove diagnostic users 'reviewer' and 'annotator'")
  .action(async () => {
    await runAuthenticated(getGlobalOptions(), diagnosticAccessRemove);
  });

// --- Maintenance Commands ---
const maintenanceCmd = program.command('maintenance').description('Maintenance mode controls');

maintenanceCmd
  .command('on')
  .description('Enable maintenance mode (show blocking spinner on all clients)')
  .option('--message <text>', 'Message to display', 'System maintenance in progress, please wait...')
  .action(async (cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      maintenanceOn(baseUrl, sessionId, cmdOptions.message)
    );
  });

maintenanceCmd
  .command('off')
  .description('Disable maintenance mode (remove spinner on all clients)')
  .option('--message <text>', 'Message to display in an info dialog after disabling')
  .action(async (cmdOptions) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      maintenanceOff(baseUrl, sessionId, cmdOptions.message)
    );
  });

maintenanceCmd
  .command('reload')
  .description('Force all clients to reload the page')
  .action(async () => {
    await runAuthenticated(getGlobalOptions(), maintenanceReload);
  });

maintenanceCmd
  .command('repopulate [fields...]')
  .description('Re-extract fields from TEI documents')
  .addHelpText('after', `
Available fields:
  status          Revision status from revisionDesc/change/@status
  last_revision   Timestamp from revisionDesc/change/@when

Examples:
  $ npm run manage-remote -- maintenance repopulate
  $ npm run manage-remote -- maintenance repopulate status
  $ npm run manage-remote -- maintenance repopulate status last_revision
`)
  .action(async (fields) => {
    await runAuthenticated(getGlobalOptions(), (baseUrl, sessionId) =>
      maintenanceRepopulate(baseUrl, sessionId, fields)
    );
  });

// Parse and execute
program.parse();
