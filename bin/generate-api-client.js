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
import { writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
    }, 10000);

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
 */
function generateMethodName(path, httpMethod) {
  // Remove /api/v1/ prefix and split into parts
  const pathParts = path
    .replace('/api/v1/', '')
    .split('/')
    .filter(p => p && !p.startsWith('{'));  // Remove empty and {param} parts

  // Check if we need to add method prefix (for same path with different HTTP methods)
  const needsMethodPrefix = httpMethod === 'post' && pathParts[pathParts.length - 1] !== 'login' &&
    pathParts[pathParts.length - 1] !== 'logout' && pathParts[pathParts.length - 1] !== 'set';

  // Build method name
  let parts = pathParts.map((part, index) => {
    if (index === 0) {
      return part.toLowerCase();
    }
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  });

  // Add prefix for POST methods on shared endpoints
  if (needsMethodPrefix) {
    const lastPart = parts[parts.length - 1];
    if (lastPart === 'Instructions') {
      parts[parts.length - 1] = 'SaveInstructions';
    }
  }

  // Add prefix for GET methods on shared endpoints if they return lists
  if (httpMethod === 'get' && parts[parts.length - 1] === 'Instructions') {
    parts[parts.length - 1] = 'GetInstructions';
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
 */
function generateClientCode(schema) {
  const methods = [];
  const typeDefs = extractTypeDefs(schema);

  // Only process /api/v1/ endpoints
  const v1Paths = Object.entries(schema.paths || {})
    .filter(([path]) => path.startsWith('/api/v1/'));

  for (const [path, pathItem] of v1Paths) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

      const methodName = generateMethodName(path, method);
      const description = operation.description || operation.summary || '';
      const requestBody = operation.requestBody?.content?.['application/json']?.schema;
      const responseSchema = operation.responses?.['200']?.content?.['application/json']?.schema;

      // Extract path parameters
      const pathParams = (operation.parameters || [])
        .filter(p => p.in === 'path')
        .map(p => ({ name: p.name, type: convertType(p.schema), required: p.required }));

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
      if (requestBody) {
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
      if (requestBody) params.push('requestBody');

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
        // GET request - callApi(endpoint)
        methodCode += `    return this.callApi(endpoint);\n`;
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
 * Generated from OpenAPI schema at ${new Date().toISOString()}
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

    // Generate client code
    const clientCode = generateClientCode(schema);

    // Ensure output directory exists
    await mkdir(dirname(OUTPUT_FILE), { recursive: true });

    // Write to file
    await writeFile(OUTPUT_FILE, clientCode, 'utf-8');
    console.log(`✅ Generated API client: ${OUTPUT_FILE}`);

    // Count methods
    const methodCount = (clientCode.match(/async \w+\(/g) || []).length;
    console.log(`   Generated ${methodCount} methods`);

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