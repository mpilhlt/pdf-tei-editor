#!/usr/bin/env node
/**
 * Generate API client from FastAPI OpenAPI schema
 *
 * This script:
 * 1. Starts FastAPI server temporarily
 * 2. Fetches OpenAPI spec from /openapi.json
 * 3. Generates typed JavaScript client code
 * 4. Writes to specified output file
 *
 * Usage:
 *   node bin/generate-api-client.js [output-path]
 *
 * Examples:
 *   node bin/generate-api-client.js
 *   node bin/generate-api-client.js fastapi_app/api-client-v1.js
 *   node bin/generate-api-client.js app/src/modules/api-client-v1.js
 */

import { spawn } from 'child_process';
import { writeFile, mkdir, readFile, utimes } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const SERVER_PORT = 8001;
const API_URL = `http://localhost:${SERVER_PORT}`;

// Parse output path from command line or use default
const OUTPUT_FILE = process.argv[2]
  ? join(ROOT_DIR, process.argv[2])
  : join(ROOT_DIR, 'fastapi_app/api-client-v1.js');

/**
 * Start FastAPI server on a specific port
 */
async function startServer() {
  console.log(`Starting FastAPI server on port ${SERVER_PORT}...`);

  const serverProcess = spawn('uv', ['run', 'uvicorn', 'run_fastapi:app', '--port', SERVER_PORT.toString()], {
    cwd: ROOT_DIR,
    stdio: 'pipe'
  });

  // Wait for server to be ready
  return new Promise((resolve, reject) => {
    let output = '';

    const timeout = setTimeout(() => {
      serverProcess.kill();
      reject(new Error('Server startup timeout'));
    }, 30000);

    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('Application startup complete')) {
        clearTimeout(timeout);
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      output += data.toString();
      if (output.includes('Application startup complete')) {
        clearTimeout(timeout);
        resolve(serverProcess);
      }
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Fetch OpenAPI schema from server
 */
async function fetchOpenAPISchema() {
  console.log('Fetching OpenAPI schema...');

  const response = await fetch(`${API_URL}/openapi.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI schema: ${response.status}`);
  }

  return await response.json();
}

/**
 * Convert OpenAPI type to JSDoc type
 * @param {*} schema - OpenAPI schema object
 * @param {boolean} forProperty - If true, format for property (optional uses =)
 * @returns {string} JSDoc type string
 */
function convertType(schema, forProperty = false) {
  if (!schema) return 'any';

  if (schema.$ref) {
    const typeName = schema.$ref.split('/').pop();
    return typeName;
  }

  // Handle nullable/optional types (OpenAPI 3.1 anyOf style)
  if (schema.anyOf) {
    const types = schema.anyOf.map(s => convertType(s, false)).filter(t => t !== 'null');
    const hasNull = schema.anyOf.some(s => s.type === 'null');

    if (types.length === 1 && hasNull) {
      // Single type + null = optional
      return forProperty ? types[0] : `(${types[0]} | null)`;
    }
    if (types.length > 0) {
      return `(${types.join(' | ')})`;
    }
  }

  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  if (schema.type === 'array') {
    const itemType = convertType(schema.items);
    return `Array<${itemType}>`;
  }
  if (schema.type === 'object') {
    if (schema.properties) {
      const props = Object.entries(schema.properties)
        .map(([key, val]) => `${key}: ${convertType(val)}`)
        .join(', ');
      return `{${props}}`;
    }
    // Generic object (like config dictionary)
    return 'Object<string, any>';
  }

  return 'any';
}

/**
 * Generate method name from path and method
 * /api/v1/auth/login POST -> authLogin
 * /api/v1/config/list GET -> configList
 * /api/v1/config/get/{key} GET -> configGet
 * /api/v1/config/instructions GET -> configGetInstructions
 * /api/v1/config/instructions POST -> configSaveInstructions
 * /api/v1/validate/autocomplete-data POST -> validateAutocompleteData
 * /api/v1/files/check_lock POST -> filesCheckLock
 *
 * @param {string} path - API path
 * @param {string} httpMethod - HTTP method (get, post, put, delete, patch)
 * @param {Set<string>} pathsWithMultipleMethods - Set of paths that have multiple HTTP methods
 */
function generateMethodName(path, httpMethod, pathsWithMultipleMethods) {
  // Remove /api/v1/ prefix and split into parts
  const pathParts = path
    .replace('/api/v1/', '')
    .split('/')
    .filter(p => p && !p.startsWith('{'));  // Remove empty and {param} parts

  // Build method name - convert hyphens and underscores to camelCase
  let parts = pathParts.map((part, index) => {
    // Replace hyphens and underscores with spaces, then camelCase
    const words = part.replace(/[-_]/g, ' ').split(' ');
    const camelWords = words.map((word, wordIndex) => {
      if (index === 0 && wordIndex === 0) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
    return camelWords.join('');
  });

  // Check if path has parameters
  const hasPathParams = path.includes('{');

  // If this path has multiple HTTP methods, add semantic verb prefix
  if (pathsWithMultipleMethods.has(path)) {
    const lastPart = parts[parts.length - 1];

    // Map HTTP methods to semantic prefixes
    // For GET: use "List" if no params (listing operation), "Get" if has params (get single item)
    const verbMap = {
      'get': (!hasPathParams ? 'List' : 'Get'),
      'post': lastPart === 'Instructions' ? 'Save' : 'Create',
      'put': 'Update',
      'patch': 'Patch',
      'delete': 'Delete'
    };

    const prefix = verbMap[httpMethod] || httpMethod.charAt(0).toUpperCase() + httpMethod.slice(1);

    // Insert prefix before the last part for better readability
    // e.g., config + Instructions + POST -> configSaveInstructions
    // e.g., collections + GET (no params) -> listCollections
    // e.g., collections/{id} + GET -> getCollections
    const prefixedLastPart = prefix + lastPart.charAt(0).toUpperCase() + lastPart.slice(1);

    // If this is the only part (at index 0), lowercase the first letter
    if (parts.length === 1) {
      parts[0] = prefixedLastPart.charAt(0).toLowerCase() + prefixedLastPart.slice(1);
    } else {
      parts[parts.length - 1] = prefixedLastPart;
    }
  }

  return parts.join('');
}

/**
 * Extract type definitions from schema components
 */
function extractTypeDefs(schema) {
  const typeDefs = [];
  const components = schema.components?.schemas || {};

  for (const [typeName, typeSchema] of Object.entries(components)) {
    if (typeSchema.type === 'object' && typeSchema.properties) {
      let typedef = `/**\n * @typedef {Object} ${typeName}\n`;

      for (const [propName, propSchema] of Object.entries(typeSchema.properties)) {
        const required = typeSchema.required?.includes(propName);

        // Get base type
        let propType = convertType(propSchema, true);

        // Handle optional properties properly: {type}= for optional
        typedef += ` * @property {${propType}${required ? '' : '='}} ${propName}`;

        if (propSchema.description) {
          typedef += ` - ${propSchema.description}`;
        }
        typedef += '\n';
      }

      typedef += ' */';
      typeDefs.push(typedef);
    }
  }

  return typeDefs;
}

/**
 * Generate client code from OpenAPI schema
 * @param {Object} schema - OpenAPI schema
 * @param {string} timestamp - ISO timestamp to embed in the header
 */
function generateClientCode(schema, timestamp) {
  const methods = [];
  const typeDefs = extractTypeDefs(schema);

  // Only process /api/v1/ endpoints (exclude /api/plugins which are unversioned plugin routes)
  const v1Paths = Object.entries(schema.paths || {})
    .filter(([path]) => path.startsWith('/api/v1/') && !path.startsWith('/api/plugins/'));

  // First pass: identify paths with multiple HTTP methods
  const pathMethodCounts = new Map();
  for (const [path, pathItem] of v1Paths) {
    const httpMethods = Object.keys(pathItem).filter(m =>
      ['get', 'post', 'put', 'delete', 'patch'].includes(m)
    );

    // Skip paths with SSE or multipart endpoints
    const hasSkippableEndpoint = httpMethods.some(method => {
      const operation = pathItem[method];
      const requestBodyContent = operation.requestBody?.content;
      const responseContent = operation.responses?.['200']?.content;
      return (requestBodyContent && requestBodyContent['multipart/form-data']) ||
             (responseContent && responseContent['text/event-stream']);
    });

    if (!hasSkippableEndpoint) {
      pathMethodCounts.set(path, httpMethods.length);
    }
  }

  // Paths that have multiple HTTP methods need disambiguation
  const pathsWithMultipleMethods = new Set(
    Array.from(pathMethodCounts.entries())
      .filter(([_, count]) => count > 1)
      .map(([path, _]) => path)
  );

  for (const [path, pathItem] of v1Paths) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

      // Skip file upload endpoints (multipart/form-data)
      const requestBodyContent = operation.requestBody?.content;
      if (requestBodyContent && requestBodyContent['multipart/form-data']) {
        console.log(`  Skipping upload endpoint: ${method.toUpperCase()} ${path}`);
        continue;
      }

      // Skip SSE endpoints (text/event-stream)
      const responseContent = operation.responses?.['200']?.content;
      if (responseContent && responseContent['text/event-stream']) {
        console.log(`  Skipping SSE endpoint: ${method.toUpperCase()} ${path}`);
        continue;
      }

      const methodName = generateMethodName(path, method, pathsWithMultipleMethods);
      const description = operation.description || operation.summary || '';
      const requestBody = operation.requestBody?.content?.['application/json']?.schema;
      const responseSchema = operation.responses?.['200']?.content?.['application/json']?.schema;

      // Extract path parameters
      const pathParams = (operation.parameters || [])
        .filter(p => p.in === 'path')
        .map(p => ({ name: p.name, type: convertType(p.schema), required: p.required }));

      // Extract query parameters (only for GET requests)
      const queryParams = (operation.parameters || [])
        .filter(p => p.in === 'query')
        .map(p => ({ name: p.name, type: convertType(p.schema), required: p.required }));

      // For GET requests with query params, we pass a single object parameter
      const hasQueryParams = method === 'get' && queryParams.length > 0;

      // Build JSDoc
      let jsdoc = '  /**\n';
      if (description) {
        // Handle multi-line descriptions properly
        const lines = description.split('\n').filter(l => l.trim());
        lines.forEach(line => {
          jsdoc += `   * ${line.trim()}\n`;
        });
        jsdoc += '   *\n';
      }

      // Add parameters to JSDoc
      if (pathParams.length > 0) {
        pathParams.forEach(param => {
          jsdoc += `   * @param {${param.type}} ${param.name}\n`;
        });
      }
      if (hasQueryParams) {
        // For GET with query params, accept an optional params object
        jsdoc += `   * @param {Object=} params - Query parameters\n`;
        queryParams.forEach(qp => {
          const optional = qp.required ? '' : '=';
          jsdoc += `   * @param {${qp.type}${optional}} params.${qp.name}\n`;
        });
      } else if (requestBody) {
        jsdoc += `   * @param {${convertType(requestBody)}} requestBody\n`;
      }

      // Add return type
      if (responseSchema) {
        jsdoc += `   * @returns {Promise<${convertType(responseSchema)}>}\n`;
      } else {
        jsdoc += `   * @returns {Promise<void>}\n`;
      }
      jsdoc += '   */\n';

      // Build method signature
      const params = [];
      pathParams.forEach(p => params.push(p.name));
      if (hasQueryParams) {
        params.push('params');
      } else if (requestBody) {
        params.push('requestBody');
      }

      let methodCode = jsdoc;
      methodCode += `  async ${methodName}(${params.join(', ')}) {\n`;

      // Build URL with path parameters
      let urlPath = path.replace('/api/v1', '');
      pathParams.forEach(p => {
        urlPath = urlPath.replace(`{${p.name}}`, `\${${p.name}}`);
      });

      methodCode += `    const endpoint = \`${urlPath}\`\n`;

      // Build callApi call: callApi(endpoint, method, body)
      if (method === 'get') {
        // GET request with optional query params - callApi handles conversion to query string
        if (hasQueryParams) {
          methodCode += `    return this.callApi(endpoint, 'GET', params);\n`;
        } else {
          // GET request without params
          methodCode += `    return this.callApi(endpoint);\n`;
        }
      } else if (requestBody) {
        // POST/PUT/DELETE with body - callApi(endpoint, method, body)
        methodCode += `    return this.callApi(endpoint, '${method.toUpperCase()}', requestBody);\n`;
      } else {
        // POST/PUT/DELETE without body - callApi(endpoint, method)
        methodCode += `    return this.callApi(endpoint, '${method.toUpperCase()}');\n`;
      }

      methodCode += `  }\n`;

      methods.push(methodCode);
    }
  }

  // Build full file with typedefs
  let code = `/**
 * Auto-generated API client for PDF-TEI Editor API v1
 *
 * Generated from OpenAPI schema at ${timestamp}
 *
 * DO NOT EDIT MANUALLY - regenerate using: npm run generate-client
 */

// Type Definitions
${typeDefs.join('\n\n')}

/**
 * API Client for FastAPI v1 endpoints
 *
 * This client wraps the callApi function to provide typed methods for all API endpoints.
 *
 * @example
 * const client = new ApiClientV1(callApi);
 * const { sessionId } = await client.authLogin({ username: 'admin', passwd_hash: '...' });
 */
export class ApiClientV1 {
  /**
   * Create a new API client
   * @param {Function} callApiFn - The callApi function from the application
   */
  constructor(callApiFn) {
    this.callApi = callApiFn;
  }

${methods.join('\n')}
}
`;

  return code;
}

/**
 * Main execution
 */
async function main() {
  let serverProcess = null;

  try {
    console.log(`Output file: ${OUTPUT_FILE}`);

    // Start server
    serverProcess = await startServer();
    console.log('Server started successfully');

    // Wait a bit for full initialization
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Fetch schema
    const schema = await fetchOpenAPISchema();
    console.log(`Fetched schema with ${Object.keys(schema.paths || {}).length} endpoints`);

    // Check if file exists and read existing content
    let existingCode = null;
    let existingTimestamp = null;
    if (existsSync(OUTPUT_FILE)) {
      existingCode = await readFile(OUTPUT_FILE, 'utf-8');
      // Extract timestamp from existing file
      const timestampMatch = existingCode.match(/Generated from OpenAPI schema at (.+)/);
      if (timestampMatch) {
        existingTimestamp = timestampMatch[1];
      }
    }

    // Generate client code with existing timestamp (to compare content)
    const testTimestamp = existingTimestamp || new Date().toISOString();
    const clientCode = generateClientCode(schema, testTimestamp);

    // Compare content without timestamp
    if (existingCode && existingCode === clientCode) {
      console.log(`✅ API client unchanged: ${OUTPUT_FILE}`);
      console.log('   Skipping write (no changes detected)');

      // Touch the file to update mtime for git hooks
      const now = new Date();
      await utimes(OUTPUT_FILE, now, now);
    } else {
      // Content changed, generate with new timestamp
      const newTimestamp = new Date().toISOString();
      const updatedClientCode = generateClientCode(schema, newTimestamp);

      // Ensure output directory exists
      await mkdir(dirname(OUTPUT_FILE), { recursive: true });

      // Write to file
      await writeFile(OUTPUT_FILE, updatedClientCode, 'utf-8');
      console.log(`✅ Generated API client: ${OUTPUT_FILE}`);

      // Count methods
      const methodCount = (updatedClientCode.match(/async \w+\(/g) || []).length;
      console.log(`   Generated ${methodCount} methods`);
    }

  } catch (error) {
    console.error('❌ Error generating client:', error.message);
    process.exit(1);
  } finally {
    // Stop server
    if (serverProcess) {
      console.log('Stopping server...');
      serverProcess.kill();

      // Wait for clean shutdown
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

main();