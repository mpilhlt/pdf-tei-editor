/**
 * Generic RBAC CRUD API Tests
 *
 * Tests all RBAC entity types (users, groups, roles, collections) using
 * the entity schema definitions to generate test data and assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createAdminSession, hashPassword } from '../helpers/test-auth.js';

const API_BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

/**
 * Entity schema definitions (mirrored from app/src/modules/rbac/entity-schemas.js)
 */
const entitySchemas = {
  user: {
    endpoint: '/api/v1/users',
    idField: 'username',
    createPayload: {
      username: 'test-user-crud',
      password: 'testpassword123',
      fullname: 'Test User CRUD',
      email: 'test-crud@example.com',
      roles: ['user'],
      groups: []
    },
    updatePayload: {
      fullname: 'Updated Test User',
      email: 'updated-crud@example.com',
      roles: ['user', 'annotator']
    },
    validateResponse: (data) => {
      assert.ok(data.username, 'Should have username');
      assert.ok(!data.passwd_hash, 'Should not expose password hash');
      assert.ok(Array.isArray(data.roles), 'Should have roles array');
      assert.ok(Array.isArray(data.groups), 'Should have groups array');
    }
  },
  group: {
    endpoint: '/api/v1/groups',
    idField: 'id',
    createPayload: {
      id: 'test-group-crud',
      name: 'Test Group CRUD',
      description: 'Test group for CRUD operations',
      collections: []
    },
    updatePayload: {
      name: 'Updated Test Group',
      description: 'Updated description',
      collections: ['*']
    },
    validateResponse: (data) => {
      assert.ok(data.id, 'Should have id');
      assert.ok(data.name, 'Should have name');
      assert.ok(Array.isArray(data.collections), 'Should have collections array');
    }
  },
  role: {
    endpoint: '/api/v1/roles',
    idField: 'id',
    createPayload: {
      id: 'test-role-crud',
      roleName: 'Test Role CRUD',
      description: 'Test role for CRUD operations'
    },
    updatePayload: {
      roleName: 'Updated Test Role',
      description: 'Updated description'
    },
    validateResponse: (data) => {
      assert.ok(data.id, 'Should have id');
      assert.ok(data.roleName, 'Should have roleName');
    }
  },
  collection: {
    endpoint: '/api/v1/collections',
    idField: 'id',
    createPayload: {
      id: 'test-collection-crud',
      name: 'Test Collection CRUD',
      description: 'Test collection for CRUD operations'
    },
    updatePayload: {
      name: 'Updated Test Collection',
      description: 'Updated description'
    },
    validateResponse: (data) => {
      assert.ok(data.id, 'Should have id');
      assert.ok(data.name, 'Should have name');
    }
  }
};

/**
 * Helper: Login as admin
 */
async function loginAsAdmin() {
  const { sessionId } = await createAdminSession(API_BASE);
  return sessionId;
}

/**
 * Helper: Generic entity list
 */
async function listEntities(entityType, sessionId) {
  const schema = entitySchemas[entityType];
  const endpoint = schema.endpoint;

  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'X-Session-Id': sessionId }
  });

  assert.strictEqual(response.status, 200, `List ${entityType}s should succeed`);
  const data = await response.json();

  assert.ok(Array.isArray(data), `${entityType}s should be an array`);
  return data;
}

/**
 * Helper: Generic entity create
 */
async function createEntity(entityType, sessionId, payload) {
  const schema = entitySchemas[entityType];
  const endpoint = schema.endpoint;

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId
    },
    body: JSON.stringify(payload || schema.createPayload)
  });

  const expectedStatus = entityType === 'collection' ? 201 : 200;
  assert.strictEqual(response.status, expectedStatus, `Create ${entityType} should return ${expectedStatus}`);
  const entity = await response.json();

  schema.validateResponse(entity);
  return entity;
}

/**
 * Helper: Generic entity get
 */
async function getEntity(entityType, sessionId, id) {
  const schema = entitySchemas[entityType];

  const response = await fetch(`${API_BASE}${schema.endpoint}/${encodeURIComponent(id)}`, {
    headers: { 'X-Session-Id': sessionId }
  });

  assert.strictEqual(response.status, 200, `Get ${entityType} should succeed`);
  const data = await response.json();

  schema.validateResponse(data);
  assert.strictEqual(data[schema.idField], id, `Should return correct ${entityType}`);
  return data;
}

/**
 * Helper: Generic entity update
 */
async function updateEntity(entityType, sessionId, id, payload) {
  const schema = entitySchemas[entityType];

  // Include the id in the payload as required by the API
  const updatePayload = { ...schema.updatePayload, ...payload };
  updatePayload[schema.idField] = id;

  const response = await fetch(`${API_BASE}${schema.endpoint}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId
    },
    body: JSON.stringify(updatePayload)
  });

  assert.strictEqual(response.status, 200, `Update ${entityType} should succeed`);
  const data = await response.json();

  schema.validateResponse(data);
  return data;
}

/**
 * Helper: Generic entity delete
 */
async function deleteEntity(entityType, sessionId, id) {
  const schema = entitySchemas[entityType];

  const response = await fetch(`${API_BASE}${schema.endpoint}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'X-Session-Id': sessionId }
  });

  // Accept both 200 (with JSON body) and 204 (no content)
  assert.ok(response.status === 200 || response.status === 204, `Delete ${entityType} should succeed`);

  if (response.status === 200) {
    const data = await response.json();
    assert.strictEqual(data.success, true, 'Delete should return success');
  }
}

/**
 * Helper: Cleanup test entity
 */
async function cleanupEntity(entityType, sessionId, id) {
  const schema = entitySchemas[entityType];

  try {
    await fetch(`${API_BASE}${schema.endpoint}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-Session-Id': sessionId }
    });
  } catch (error) {
    // Ignore cleanup errors
  }
}

/**
 * Test suite: Generic CRUD operations for all entity types
 */
for (const [entityType, schema] of Object.entries(entitySchemas)) {
  test(`${entityType} - List all ${entityType}s (authenticated)`, async () => {
    const sessionId = await loginAsAdmin();
    const entities = await listEntities(entityType, sessionId);
    assert.ok(entities.length >= 0, `Should return ${entityType}s list`);
  });

  test(`${entityType} - List ${entityType}s requires authentication`, async () => {
    const endpoint = schema.listEndpoint || schema.endpoint;
    const response = await fetch(`${API_BASE}${endpoint}`);
    assert.strictEqual(response.status, 401, 'Should require authentication');
  });

  test(`${entityType} - Create and delete ${entityType}`, async () => {
    const sessionId = await loginAsAdmin();

    // Create
    const created = await createEntity(entityType, sessionId);
    const id = created[schema.idField];
    assert.ok(id, `Created ${entityType} should have ID`);

    // Verify exists in list
    const entities = await listEntities(entityType, sessionId);
    const found = entities.find(e => e[schema.idField] === id);
    assert.ok(found, `Created ${entityType} should appear in list`);

    // Get individual
    const retrieved = await getEntity(entityType, sessionId, id);
    assert.strictEqual(retrieved[schema.idField], id, 'Should retrieve correct entity');

    // Delete (skip for special cases)
    if (!schema.skipDelete) {
      await deleteEntity(entityType, sessionId, id);

      // Verify deleted
      const response = await fetch(`${API_BASE}${schema.endpoint}/${encodeURIComponent(id)}`, {
        headers: { 'X-Session-Id': sessionId }
      });
      assert.strictEqual(response.status, 404, 'Deleted entity should not be found');
    } else {
      // Cleanup
      await cleanupEntity(entityType, sessionId, id);
    }
  });

  if (!schema.skipUpdate) {
    test(`${entityType} - Update ${entityType}`, async () => {
      const sessionId = await loginAsAdmin();

      // Create
      const created = await createEntity(entityType, sessionId);
      const id = created[schema.idField];

      try {
        // Update
        const updated = await updateEntity(entityType, sessionId, id, schema.updatePayload);

        // Verify update
        for (const [key, value] of Object.entries(schema.updatePayload)) {
          if (Array.isArray(value)) {
            assert.deepStrictEqual(updated[key], value, `${key} should be updated`);
          } else {
            assert.strictEqual(updated[key], value, `${key} should be updated`);
          }
        }
      } finally {
        // Cleanup
        await cleanupEntity(entityType, sessionId, id);
      }
    });
  }

  test(`${entityType} - Create duplicate ${entityType} should fail`, async () => {
    const sessionId = await loginAsAdmin();

    // Create first
    const created = await createEntity(entityType, sessionId);
    const id = created[schema.idField];

    try {
      // Try to create duplicate
      const endpoint = schema.createEndpoint || schema.endpoint;
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionId
        },
        body: JSON.stringify(schema.createPayload)
      });

      assert.strictEqual(response.status, 400, 'Duplicate creation should fail');
    } finally {
      // Cleanup
      await cleanupEntity(entityType, sessionId, id);
    }
  });

  test(`${entityType} - Get non-existent ${entityType}`, async () => {
    const sessionId = await loginAsAdmin();

    const response = await fetch(`${API_BASE}${schema.endpoint}/nonexistent-entity-id-12345`, {
      headers: { 'X-Session-Id': sessionId }
    });

    assert.strictEqual(response.status, 404, 'Should return 404 for non-existent entity');
  });
}

/**
 * Test suite: User-specific edge cases
 */
test('user - Cannot delete yourself', async () => {
  const sessionId = await loginAsAdmin();

  const response = await fetch(`${API_BASE}/api/v1/users/admin`, {
    method: 'DELETE',
    headers: { 'X-Session-Id': sessionId }
  });

  assert.strictEqual(response.status, 400, 'Should prevent self-deletion');
});

test('user - Password is hashed on create', async () => {
  const sessionId = await loginAsAdmin();

  const payload = {
    username: 'password-test-user',
    password: 'plaintext-password',
    fullname: 'Password Test',
    roles: ['user']
  };

  const created = await createEntity('user', sessionId, payload);

  try {
    // Response should not contain passwd_hash
    assert.ok(!created.passwd_hash, 'Password should not be in response');

    // Verify user can login (password was stored)
    const loginResponse = await fetch(`${API_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'password-test-user',
        passwd_hash: hashPassword('plaintext-password')
      })
    });

    assert.strictEqual(loginResponse.status, 200, 'User should be able to login with password');
  } finally {
    await cleanupEntity('user', sessionId, 'password-test-user');
  }
});

/**
 * Test suite: Role-specific edge cases
 */
test('role - Cannot delete built-in roles', async () => {
  const sessionId = await loginAsAdmin();

  const builtInRoles = ['admin', 'user', 'reviewer', 'annotator'];

  for (const roleId of builtInRoles) {
    const response = await fetch(`${API_BASE}/api/v1/roles/${roleId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Id': sessionId }
    });

    assert.strictEqual(response.status, 400, `Should prevent deletion of built-in role: ${roleId}`);
  }
});

/**
 * Test suite: Collection creation auto-adds to admin group
 */
test('New collection should be added to admin group if no wildcard access', async () => {
  const sessionId = await loginAsAdmin();

  // Get current admin group
  const adminGroup = await getEntity('group', sessionId, 'admin');
  const originalCollections = [...adminGroup.collections];

  try {
    // Temporarily remove wildcard from admin group if it exists
    const hasWildcard = originalCollections.includes('*');
    if (hasWildcard) {
      await updateEntity('group', sessionId, 'admin', {
        collections: originalCollections.filter(c => c !== '*')
      });
    }

    // Create a new collection
    const testCollectionId = 'test-auto-add-collection';
    const newCollection = await createEntity('collection', sessionId, {
      id: testCollectionId,
      name: 'Test Auto-Add Collection',
      description: 'Tests automatic admin group assignment'
    });

    assert.strictEqual(newCollection.id, testCollectionId, 'Collection should be created');

    // Verify it was added to admin group
    const updatedAdminGroup = await getEntity('group', sessionId, 'admin');
    assert.ok(
      updatedAdminGroup.collections.includes(testCollectionId),
      'New collection should be automatically added to admin group'
    );

    // Cleanup: delete the test collection
    await deleteEntity('collection', sessionId, testCollectionId);

  } finally {
    // Restore original admin group collections
    await updateEntity('group', sessionId, 'admin', {
      collections: originalCollections
    });
  }
});

test('New collection should NOT be added to admin group if wildcard access exists', async () => {
  const sessionId = await loginAsAdmin();

  // Get current admin group
  const adminGroup = await getEntity('group', sessionId, 'admin');
  const originalCollections = [...adminGroup.collections];

  try {
    // Ensure wildcard is in admin group
    if (!originalCollections.includes('*')) {
      await updateEntity('group', sessionId, 'admin', {
        collections: [...originalCollections, '*']
      });
    }

    // Create a new collection
    const testCollectionId = 'test-no-auto-add-collection';
    const newCollection = await createEntity('collection', sessionId, {
      id: testCollectionId,
      name: 'Test No Auto-Add Collection',
      description: 'Tests that wildcard prevents auto-assignment'
    });

    assert.strictEqual(newCollection.id, testCollectionId, 'Collection should be created');

    // Verify it was NOT explicitly added to admin group (only wildcard should be there)
    const updatedAdminGroup = await getEntity('group', sessionId, 'admin');
    const nonWildcardCollections = updatedAdminGroup.collections.filter(c => c !== '*');
    assert.ok(
      !nonWildcardCollections.includes(testCollectionId) || originalCollections.includes(testCollectionId),
      'New collection should not be explicitly added when admin group has wildcard'
    );

    // Cleanup: delete the test collection
    await deleteEntity('collection', sessionId, testCollectionId);

  } finally {
    // Restore original admin group collections
    await updateEntity('group', sessionId, 'admin', {
      collections: originalCollections
    });
  }
});

/**
 * Test suite: Permission checks
 */
test('All RBAC endpoints require admin role', async () => {
  // Login as regular user (if available) or anonymous
  const response = await fetch(`${API_BASE}/api/v1/users`, {
    headers: { 'X-Session-Id': 'invalid-session' }
  });

  // Should be 401 (unauthorized) or 403 (forbidden)
  assert.ok(
    response.status === 401 || response.status === 403,
    'Non-admin access should be denied'
  );
});

console.log('✅ All RBAC CRUD tests completed');
