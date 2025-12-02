import { createServer } from 'net';

/**
 * Port Allocator - Find available ports for test servers
 *
 * Provides utilities for finding unused ports in the 8010-8999 range
 * to avoid conflicts with running services and allow parallel test execution.
 */

/**
 * Check if a port is available
 *
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} True if port is available
 */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port in the specified range
 *
 * @param {number} [startPort=8010] - Start of port range
 * @param {number} [endPort=8999] - End of port range
 * @param {number[]} [excludePorts=[]] - Ports to exclude from search
 * @returns {Promise<number>} Available port number
 * @throws {Error} If no available port found in range
 */
export async function findAvailablePort(startPort = 8010, endPort = 8999, excludePorts = []) {
  for (let port = startPort; port <= endPort; port++) {
    if (excludePorts.includes(port)) {
      continue;
    }

    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available port found in range ${startPort}-${endPort}`);
}

/**
 * Allocate multiple ports ensuring they don't conflict
 *
 * @param {number} count - Number of ports to allocate
 * @param {number} [startPort=8010] - Start of port range
 * @param {number} [endPort=8999] - End of port range
 * @returns {Promise<number[]>} Array of allocated port numbers
 * @throws {Error} If unable to allocate requested number of ports
 */
export async function allocateports(count, startPort = 8010, endPort = 8999) {
  const ports = [];
  const excludePorts = [];

  for (let i = 0; i < count; i++) {
    const port = await findAvailablePort(startPort, endPort, excludePorts);
    ports.push(port);
    excludePorts.push(port);
  }

  return ports;
}

/**
 * Get default port with fallback to available port
 *
 * @param {number} preferredPort - Preferred port number
 * @param {number} [startPort=8010] - Start of fallback range
 * @param {number} [endPort=8999] - End of fallback range
 * @param {number[]} [excludePorts=[]] - Ports to exclude from search
 * @returns {Promise<number>} Port number (preferred or fallback)
 */
export async function getPortWithFallback(preferredPort, startPort = 8010, endPort = 8999, excludePorts = []) {
  if (await isPortAvailable(preferredPort) && !excludePorts.includes(preferredPort)) {
    return preferredPort;
  }

  console.log(`[INFO] Port ${preferredPort} is in use, finding alternative...`);
  const alternativePort = await findAvailablePort(startPort, endPort, excludePorts);
  console.log(`[INFO] Using port ${alternativePort} instead`);
  return alternativePort;
}
