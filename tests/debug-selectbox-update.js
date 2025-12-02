/**
 * Debug script to test XML selectbox update after version creation
 * Run with: node tests/debug-selectbox-update.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from './api/helpers/test-auth.js';
import { logger } from './api/helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

const createTeiXml = (docId, content, variant = null) => {
  const variantLabel = variant ? `<label type="variant-id">${variant}</label>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document ${docId}</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <title>Test Edition</title>
          <idno type="fileref">${docId}</idno>
        </edition>
      </editionStmt>
      <publicationStmt>
        <p>Test publication</p>
      </publicationStmt>
      <sourceDesc>
        <p>Test source</p>
        <application type="extractor">
          ${variantLabel}
        </application>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <div>
        <p>${content}</p>
      </div>
    </body>
  </text>
</TEI>`;
};

describe('Debug: XML selectbox update after version creation', () => {
  test('Create gold, create version, verify fileref and file_id', async () => {
    const reviewerSession = await login('reviewer', 'reviewer', BASE_URL);
    const testRunId = Math.random().toString(36).substring(2, 15);
    const docId = `debug-selectbox-${testRunId}`;

    // Step 1: Create gold standard
    logger.info('Step 1: Creating gold standard...');
    const goldXml = createTeiXml(docId, 'Gold content', 'grobid.training.segmentation');
    const goldResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: docId,
        xml_string: goldXml,
        new_version: false
      },
      BASE_URL
    );

    logger.info(`Gold file created: ${goldResponse.file_id}`);
    assert.ok(goldResponse.file_id, 'Should have gold file_id');

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: goldResponse.file_id },
      BASE_URL
    );

    // Step 2: Get file data to verify gold structure
    logger.info('\nStep 2: Getting file data...');
    const fileDataResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const ourFile = fileDataResponse.files.find(f => f.doc_id === docId);
    logger.info('File data:', JSON.stringify(ourFile, null, 2));

    // Step 3: Create version from gold
    logger.info('\nStep 3: Creating version from gold...');
    const versionXml = createTeiXml(docId, 'Version 1 content', 'grobid.training.segmentation');
    const versionResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/save',
      'POST',
      {
        file_id: goldResponse.file_id,
        xml_string: versionXml,
        new_version: true
      },
      BASE_URL
    );

    logger.info(`Version file created: ${versionResponse.file_id}`);
    assert.ok(versionResponse.file_id, 'Should have version file_id');

    // Release lock
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: versionResponse.file_id },
      BASE_URL
    );

    // Step 4: Get file data again to verify version structure
    logger.info('\nStep 4: Getting updated file data...');
    const updatedFileDataResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/list',
      'GET',
      null,
      BASE_URL
    );

    const updatedFile = updatedFileDataResponse.files.find(f => f.doc_id === docId);
    logger.info('Updated file data:', JSON.stringify(updatedFile, null, 2));

    // Step 5: Get the actual XML content to check fileref
    logger.info('\nStep 5: Checking fileref in version XML...');
    const versionXmlResponse = await authenticatedApiCall(
      reviewerSession.sessionId,
      `/files/${versionResponse.file_id}`,
      'GET',
      null,
      BASE_URL
    );

    logger.info('Version XML length:', versionXmlResponse.length);

    // Extract fileref from XML
    const filerefMatch = versionXmlResponse.match(/<idno type="fileref">([^<]+)<\/idno>/);
    if (filerefMatch) {
      logger.info(`Fileref in XML: ${filerefMatch[1]}`);
      logger.info(`Expected doc_id: ${docId}`);
      logger.info(`Match: ${filerefMatch[1] === docId ? '✓' : '✗'}`);
    } else {
      logger.warn('No fileref found in XML!');
    }

    // Cleanup
    logger.info('\nCleaning up...');
    await authenticatedApiCall(
      reviewerSession.sessionId,
      '/files/delete',
      'POST',
      { files: [goldResponse.file_id, versionResponse.file_id] },
      BASE_URL
    );
    logger.success('Test complete');
  });
});
