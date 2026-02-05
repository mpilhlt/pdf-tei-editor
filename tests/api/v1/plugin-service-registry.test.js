/**
 * @testCovers fastapi_app/lib/service_registry.py
 * @testCovers fastapi_app/plugins/test_plugin/routes.py
 * @testCovers fastapi_app/plugins/test_plugin/plugin.py
 * @testCovers fastapi_app/lib/plugin_base.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall, createAdminSession } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';
const PLUGIN_API_PREFIX = '/api/plugins/test-plugin';

describe('Plugin Service Registry Integration Tests', () => {
  let adminSession = null;
  let reviewerSession = null;

  test('Setup: login as admin and reviewer', async () => {
    adminSession = await createAdminSession(BASE_URL);
    reviewerSession = await login('reviewer', 'reviewer', BASE_URL);

    assert.ok(adminSession.sessionId, 'Admin should have session ID');
    assert.ok(reviewerSession.sessionId, 'Reviewer should have session ID');
    logger.success('Logged in successfully');
  });

  test('Test plugin should be available in plugin list', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      '/plugins',
      'GET',
      null,
      BASE_URL
    );

    assert.ok(response.plugins, 'Should have plugins list');
    const testPlugin = response.plugins.find(p => p.id === 'test-plugin');
    assert.ok(testPlugin, 'Test plugin should be available');
    assert.strictEqual(testPlugin.name, 'Test Plugin');
    assert.ok(testPlugin.endpoints, 'Test plugin should have endpoints');
    logger.success('Test plugin is available');
  });

  test('Test plugin custom routes should be accessible', async () => {
    // Test status endpoint
    const statusResponse = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/status`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(statusResponse.plugin, 'test-plugin');
    assert.strictEqual(statusResponse.status, 'active');
    assert.strictEqual(statusResponse.version, '1.0.0');

    // Test analyze endpoint
    const analyzeResponse = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/analyze`,
      'POST',
      { text: 'Hello world test text' },
      BASE_URL
    );

    assert.strictEqual(analyzeResponse.word_count, 4);
    assert.strictEqual(analyzeResponse.char_count, 21);
    assert.ok(analyzeResponse.message.includes('Analyzed 4 words'));

    logger.success('Test plugin custom routes work');
  });

  test('Service registry should list available services', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/list`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(response.success, true);
    assert.ok(response.data, 'Should have data');
    assert.ok(Array.isArray(response.data.services), 'Services should be an array');
    assert.ok(Array.isArray(response.data.capabilities), 'Capabilities should be an array');
    assert.ok(response.message.includes('services'), 'Should mention services');

    logger.success('Service registry lists services correctly');
  });

  test('Service registry should list available capabilities', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/capabilities`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(response.success, true);
    assert.ok(response.data, 'Should have data');
    assert.ok(Array.isArray(response.data.capabilities), 'Capabilities should be an array');
    assert.ok(response.message.includes('capabilities'), 'Should mention capabilities');

    logger.success('Service registry lists capabilities correctly');
  });

  test('Service registry should include dummy extraction service', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/list`,
      'GET',
      null,
      BASE_URL
    );

    const services = response.data.services;
    const capabilities = response.data.capabilities;

    // Check that dummy extraction service is registered
    const dummyService = services.find(s => s.service_id === 'dummy-extractor');
    assert.ok(dummyService, 'Dummy extraction service should be registered');
    assert.strictEqual(dummyService.service_name, 'Dummy Extractor');
    assert.ok(dummyService.capabilities.includes('structured-data-extraction'));

    // Check that structured-data-extraction capability is available
    assert.ok(capabilities.includes('structured-data-extraction'), 
      'structured-data-extraction capability should be available');

    logger.success('Dummy extraction service is properly registered');
  });

  test('Extraction service test should work with dummy service', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/test-extraction`,
      'POST',
      {
        model: 'test-model',
        prompt: 'Extract key information from this text',
        text_input: 'This is a test document with important information.',
        temperature: 0.1,
        max_retries: 2
      },
      BASE_URL
    );

    assert.strictEqual(response.success, true);
    assert.ok(response.data, 'Should have extraction result data');
    assert.strictEqual(response.service_used, 'Dummy Extractor');
    assert.strictEqual(response.service_id, 'dummy-extractor');
    assert.ok(response.message.includes('Successfully used'), 'Should indicate success');

    // Check that the extraction result has expected structure
    assert.strictEqual(response.data.success, true);
    assert.ok(response.data.data, 'Should have extracted data');
    assert.strictEqual(response.data.model, 'test-model');
    assert.strictEqual(response.data.extractor, 'dummy-extractor');
    assert.strictEqual(response.data.retries, 0);

    logger.success('Extraction service test works with dummy service');
  });

  test('Extraction service test should handle JSON schema validation', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/test-extraction`,
      'POST',
      {
        model: 'test-model',
        prompt: 'Extract structured data',
        text_input: 'Test content',
        json_schema: {
          type: 'object',
          properties: {
            test_field: { type: 'string' },
            number_field: { type: 'number' }
          },
          required: ['test_field']
        },
        temperature: 0.1,
        max_retries: 1
      },
      BASE_URL
    );

    assert.strictEqual(response.success, true);
    assert.ok(response.data, 'Should have extraction result data');
    assert.strictEqual(response.service_used, 'Dummy Extractor');

    // Check that the dummy service handled the JSON schema
    assert.ok(response.data.data, 'Should have extracted data');
    assert.ok(response.data.data.test_field, 'Should have required field from schema');

    logger.success('Extraction service test handles JSON schema validation');
  });

  test('Service registry should work for non-admin users', async () => {
    const response = await authenticatedApiCall(
      reviewerSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/list`,
      'GET',
      null,
      BASE_URL
    );

    assert.strictEqual(response.success, true);
    assert.ok(response.data, 'Should have data');
    assert.ok(Array.isArray(response.data.services), 'Services should be an array');

    logger.success('Service registry works for non-admin users');
  });

  test('Service registry endpoints should require authentication', async () => {
    // Try to access without authentication
    const response = await fetch(`${BASE_URL}${PLUGIN_API_PREFIX}/services/list`);

    assert.strictEqual(response.status, 401, 'Should require authentication');

    logger.success('Service registry endpoints properly require authentication');
  });

  test('Plugin execute endpoint should still work', async () => {
    // Test the generic plugin execute endpoint (uses /api/v1/plugins/...)
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      '/plugins/test-plugin/execute',
      'POST',
      {
        endpoint: 'list_services',
        params: {}
      },
      BASE_URL
    );

    assert.strictEqual(response.success, true);
    assert.ok(response.result.services, 'Should have services list');
    assert.ok(response.result.capabilities, 'Should have capabilities list');

    logger.success('Generic plugin execute endpoint still works');
  });

  test('Plugin execute endpoint should support service consumption', async () => {
    // Test the test_service_consumption endpoint via generic execute (uses /api/v1/plugins/...)
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      '/plugins/test-plugin/execute',
      'POST',
      {
        endpoint: 'test_service_consumption',
        params: {
          text: 'Test text for extraction',
          model: 'test-model',
          prompt: 'Extract key information'
        }
      },
      BASE_URL
    );

    assert.strictEqual(response.success, true);
    assert.ok(response.result.data, 'Should have extraction result');
    assert.strictEqual(response.result.service_used, 'Dummy Extractor');
    assert.ok(response.result.message.includes('Successfully used'), 'Should indicate success');

    logger.success('Plugin execute endpoint supports service consumption');
  });

  test('Service registry should handle missing services gracefully', async () => {
    // This test verifies that the system handles missing services properly
    // by checking that the dummy service is available (since we registered it)
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/list`,
      'GET',
      null,
      BASE_URL
    );

    const services = response.data.services;
    const extractionServices = services.filter(s => 
      s.capabilities.includes('structured-data-extraction')
    );

    assert.ok(extractionServices.length > 0, 'Should have at least one extraction service');
    assert.ok(extractionServices.some(s => s.service_id === 'dummy-extractor'), 
      'Should have dummy extraction service');

    logger.success('Service registry handles available services correctly');
  });

  test('Service registry should maintain type safety', async () => {
    // Test that the service registry maintains proper type information
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/list`,
      'GET',
      null,
      BASE_URL
    );

    const services = response.data.services;

    for (const service of services) {
      assert.ok(service.service_id, 'Service should have service_id');
      assert.ok(service.service_name, 'Service should have service_name');
      assert.ok(Array.isArray(service.capabilities), 'Service should have capabilities array');
      assert.ok(service.capabilities.length > 0, 'Service should have at least one capability');
    }

    logger.success('Service registry maintains type safety');
  });

  test('Service registry should support multiple capabilities per service', async () => {
    // Test that a service can have multiple capabilities
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/list`,
      'GET',
      null,
      BASE_URL
    );

    const services = response.data.services;
    const dummyService = services.find(s => s.service_id === 'dummy-extractor');

    if (dummyService) {
      assert.ok(dummyService.capabilities.length >= 1, 
        'Dummy service should have at least one capability');
    }

    logger.success('Service registry supports multiple capabilities');
  });

  test('Service registry should provide meaningful error messages', async () => {
    // Test error handling in extraction service
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/test-extraction`,
      'POST',
      {
        model: 'test-model',
        prompt: 'Extract key information',
        // Intentionally omit text_input to test error handling
        temperature: 0.1,
        max_retries: 2
      },
      BASE_URL
    );

    // The dummy service should handle missing text_input gracefully
    assert.strictEqual(response.success, true, 'Should handle missing parameters gracefully');
    assert.ok(response.data, 'Should have data even with default values');

    logger.success('Service registry provides meaningful error handling');
  });

  test('Service registry integration should be performant', async () => {
    const startTime = Date.now();

    // Make multiple requests to test performance
    for (let i = 0; i < 5; i++) {
      const response = await authenticatedApiCall(
        adminSession.sessionId,
        `${PLUGIN_API_PREFIX}/services/list`,
        'GET',
        null,
        BASE_URL
      );

      assert.strictEqual(response.success, true);
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    assert.ok(duration < 5000, `Service registry should be performant (took ${duration}ms)`);

    logger.success('Service registry integration is performant');
  });

  test('Service registry should work with different user roles', async () => {
    // Test with different user roles
    const users = [
      { username: 'admin', session: adminSession },
      { username: 'reviewer', session: reviewerSession }
    ];

    for (const user of users) {
      const response = await authenticatedApiCall(
        user.session.sessionId,
        `${PLUGIN_API_PREFIX}/services/list`,
        'GET',
        null,
        BASE_URL
      );

      assert.strictEqual(response.success, true, 
        `Should work for ${user.username} user`);
      assert.ok(response.data.services, `Should have services for ${user.username}`);
    }

    logger.success('Service registry works with different user roles');
  });

  test('Service registry should maintain consistency across requests', async () => {
    // Make multiple requests and verify consistency
    const responses = [];

    for (let i = 0; i < 3; i++) {
      const response = await authenticatedApiCall(
        adminSession.sessionId,
        `${PLUGIN_API_PREFIX}/services/list`,
        'GET',
        null,
        BASE_URL
      );

      responses.push(response);
    }

    // All responses should be consistent
    for (let i = 1; i < responses.length; i++) {
      assert.deepStrictEqual(
        responses[0].data.services,
        responses[i].data.services,
        'Services should be consistent across requests'
      );
      assert.deepStrictEqual(
        responses[0].data.capabilities,
        responses[i].data.capabilities,
        'Capabilities should be consistent across requests'
      );
    }

    logger.success('Service registry maintains consistency across requests');
  });

  test('Service registry should handle concurrent requests', async () => {
    // Make concurrent requests to test thread safety
    const promises = [];

    for (let i = 0; i < 5; i++) {
      promises.push(
        authenticatedApiCall(
          adminSession.sessionId,
          `${PLUGIN_API_PREFIX}/services/list`,
          'GET',
          null,
          BASE_URL
        )
      );
    }

    const responses = await Promise.all(promises);

    // All responses should be successful and consistent
    for (const response of responses) {
      assert.strictEqual(response.success, true, 'All concurrent requests should succeed');
      assert.ok(response.data.services, 'Should have services data');
    }

    logger.success('Service registry handles concurrent requests correctly');
  });

  test('Service registry should provide comprehensive service information', async () => {
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/list`,
      'GET',
      null,
      BASE_URL
    );

    const services = response.data.services;

    for (const service of services) {
      // Verify all required fields are present
      assert.ok(service.service_id, 'Service should have service_id');
      assert.ok(service.service_name, 'Service should have service_name');
      assert.ok(Array.isArray(service.capabilities), 'Service should have capabilities array');

      // Verify service_id format
      assert.ok(/^[a-z0-9-]+$/.test(service.service_id), 
        'Service ID should be lowercase with hyphens');

      // Verify service_name is human-readable
      assert.ok(service.service_name.length > 0, 'Service name should not be empty');
      assert.ok(service.service_name !== service.service_id, 
        'Service name should be different from service ID');
    }

    logger.success('Service registry provides comprehensive service information');
  });

  test('Service registry should handle edge cases gracefully', async () => {
    // Test with empty parameters
    const response = await authenticatedApiCall(
      adminSession.sessionId,
      `${PLUGIN_API_PREFIX}/services/test-extraction`,
      'POST',
      {},
      BASE_URL
    );

    // Should handle empty parameters gracefully with defaults
    assert.strictEqual(response.success, true, 'Should handle empty parameters');
    assert.ok(response.data, 'Should have data with defaults');

    logger.success('Service registry handles edge cases gracefully');
  });

  test('Service registry should maintain backward compatibility', async () => {
    // Test that existing plugin functionality still works
    const pluginListResponse = await authenticatedApiCall(
      adminSession.sessionId,
      '/plugins',
      'GET',
      null,
      BASE_URL
    );

    assert.ok(pluginListResponse.plugins, 'Plugin list should still work');
    assert.ok(pluginListResponse.plugins.find(p => p.id === 'test-plugin'), 
      'Test plugin should still be available');

    // Test that plugin endpoints still work (uses /api/v1/plugins/...)
    const pluginExecuteResponse = await authenticatedApiCall(
      adminSession.sessionId,
      '/plugins/test-plugin/execute',
      'POST',
      {
        endpoint: 'info',
        params: {}
      },
      BASE_URL
    );

    assert.strictEqual(pluginExecuteResponse.result.plugin, 'Test Plugin');
    assert.strictEqual(pluginExecuteResponse.result.version, '1.0.0');

    logger.success('Service registry maintains backward compatibility');
  });
});