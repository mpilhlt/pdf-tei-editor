/**
 * E2E tests for Files Upload API endpoint
 * @testCovers backend/api/files.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession } from '../backend/helpers/test-auth.js';
import fs from 'fs';

const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

describe('Files Upload API', () => {

  test('should require authentication for upload', async () => {
    // Create a test PDF content
    const testPdfContent = '%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\nstartxref\n%%EOF';
    const formData = new FormData();
    formData.append('file', new Blob([testPdfContent], { type: 'application/pdf' }), 'test.pdf');

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      body: formData
    });

    assert.strictEqual(response.status, 401);
    const error = await response.json();
    assert(error.detail === 'Authentication required' || error.error === 'Authentication required');
  });

  test('should upload PDF file successfully with authentication', async () => {
    const { sessionId } = await createTestSession();

    // Create a test PDF content
    const testPdfContent = '%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\nstartxref\n%%EOF';
    const formData = new FormData();
    formData.append('file', new Blob([testPdfContent], { type: 'application/pdf' }), 'test-file.pdf');

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Cookie': `sessionId=${sessionId}`
      },
      body: formData
    });

    assert.strictEqual(response.status, 200);
    const result = await response.json();

    // Check response structure
    assert(result.type, 'Response should include file type');
    assert(result.filename, 'Response should include filename');
    assert.strictEqual(result.type, 'pdf');
    assert.strictEqual(result.filename, 'test-file.pdf');
  });

  test('should upload XML file successfully with authentication', async () => {
    const { sessionId } = await createTestSession();

    // Create a test XML content
    const testXmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n<root><test>content</test></root>';
    const formData = new FormData();
    formData.append('file', new Blob([testXmlContent], { type: 'application/xml' }), 'test-file.xml');

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Cookie': `sessionId=${sessionId}`
      },
      body: formData
    });

    assert.strictEqual(response.status, 200);
    const result = await response.json();

    // Check response structure
    assert.strictEqual(result.type, 'xml');
    assert.strictEqual(result.filename, 'test-file.xml');
  });

  test('should reject unsupported file types', async () => {
    const { sessionId } = await createTestSession();

    // Create a test text file (unsupported)
    const testContent = 'This is a plain text file';
    const formData = new FormData();
    formData.append('file', new Blob([testContent], { type: 'text/plain' }), 'test.txt');

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Cookie': `sessionId=${sessionId}`
      },
      body: formData
    });

    assert.strictEqual(response.status, 400);
    const error = await response.json();
    assert(error.detail.includes('Invalid file type') || error.error.includes('Invalid file type'));
  });

  test('should reject upload with no file', async () => {
    const { sessionId } = await createTestSession();

    const formData = new FormData();
    // Don't append any file

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Cookie': `sessionId=${sessionId}`
      },
      body: formData
    });

    assert.strictEqual(response.status, 422); // FastAPI validation error
  });

  test('should reject upload with empty filename', async () => {
    const { sessionId } = await createTestSession();

    const testContent = '%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\nstartxref\n%%EOF';
    const formData = new FormData();
    formData.append('file', new Blob([testContent], { type: 'application/pdf' }), ''); // Empty filename

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Cookie': `sessionId=${sessionId}`
      },
      body: formData
    });

    assert.strictEqual(response.status, 422); // FastAPI validation error
    const error = await response.json();
    // FastAPI validation errors have different structure than our custom errors
    assert(Array.isArray(error.detail) && error.detail.length > 0, 'Should have validation errors');
  });

  test('should handle filename sanitization', async () => {
    const { sessionId } = await createTestSession();

    // Create a test PDF with unsafe filename
    const testPdfContent = '%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\nstartxref\n%%EOF';
    const formData = new FormData();
    formData.append('file', new Blob([testPdfContent], { type: 'application/pdf' }), '../../../dangerous.pdf');

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Cookie': `sessionId=${sessionId}`
      },
      body: formData
    });

    assert.strictEqual(response.status, 200);
    const result = await response.json();

    // Filename should be sanitized (no path traversal)
    assert.strictEqual(result.filename, 'dangerous.pdf');
    assert.strictEqual(result.type, 'pdf');
  });

  test('should handle files with no extension', async () => {
    const { sessionId } = await createTestSession();

    // Create a test PDF with no extension
    const testPdfContent = '%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\nstartxref\n%%EOF';
    const formData = new FormData();
    formData.append('file', new Blob([testPdfContent], { type: 'application/pdf' }), 'testfile');

    const response = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        'Cookie': `sessionId=${sessionId}`
      },
      body: formData
    });

    assert.strictEqual(response.status, 200);
    const result = await response.json();

    // Should handle file with no extension
    assert.strictEqual(result.filename, 'testfile');
    assert.strictEqual(result.type, ''); // No extension
  });

});