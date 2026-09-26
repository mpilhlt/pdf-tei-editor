#!/usr/bin/env node

/**
 * Visual UI check: builds and starts the demo container from the current checkout,
 * logs in, performs optional clicks and takes a screenshot. The container and image
 * are removed afterwards.
 *
 * Usage:
 *   node scripts/dev/ui-screenshot.js [options]
 *
 * Examples:
 *   # Open the Tools menu and screenshot it
 *   node scripts/dev/ui-screenshot.js --click 'sl-button[name="toolsBtn"]' --out /tmp/tools.png
 *
 *   # Pretend an LLM provider is configured (mock an API response inline or from a JSON file)
 *   node scripts/dev/ui-screenshot.js --click 'sl-button[name="toolsBtn"]' \
 *     --mock '**\/api/v1/llm/providers={"json":[{"id":"mock","label":"Mock","models":[{"id":"m1","label":"Model 1","free":true,"status":null}]}]}'
 *
 *   # Reuse an already running instance instead of building a container
 *   node scripts/dev/ui-screenshot.js --base-url http://localhost:8000 --out /tmp/app.png
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const containerScript = path.join(projectRoot, 'scripts/deploy/container.js');

/**
 * Find a free TCP port.
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = /** @type {net.AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

/**
 * Run scripts/deploy/container.js with the given arguments.
 * @param {string[]} args
 * @param {boolean} [ignoreErrors]
 */
function container(args, ignoreErrors = false) {
  try {
    execFileSync('node', [containerScript, ...args], { cwd: projectRoot, stdio: 'inherit' });
  } catch (error) {
    if (!ignoreErrors) throw error;
  }
}

/**
 * Register a mocked response for API requests.
 * @param {import('playwright').Page} page
 * @param {string} spec - `<url glob>=<JSON route.fulfill options or path to a JSON file>`
 */
async function addMock(page, spec) {
  const idx = spec.indexOf('=');
  if (idx < 1) throw new Error(`Invalid --mock "${spec}", expected <url glob>=<json>`);
  const pattern = spec.slice(0, idx);
  const value = spec.slice(idx + 1);
  const fulfill = JSON.parse(fs.existsSync(value) ? fs.readFileSync(value, 'utf8') : value);
  await page.route(pattern, route => route.fulfill(fulfill));
}

/**
 * Wait until the server answers HTTP requests.
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function waitForServer(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs / 1000}s`);
}

/**
 * Log in through the login dialog (its sl-input elements cannot be used with `fill()`).
 * @param {import('playwright').Page} page
 * @param {string} user
 * @param {string} password
 */
async function login(page, user, password) {
  const dialog = 'sl-dialog[name="loginDialog"]';
  await page.waitForSelector(`${dialog}[open]`, { timeout: 30000 });
  await page.evaluate(([sel, u, p]) => {
    const d = document.querySelector(sel);
    /** @type {any} */ (d.querySelector('[name="username"]')).value = u;
    /** @type {any} */ (d.querySelector('[name="password"]')).value = p;
  }, [dialog, user, password]);
  await page.locator(`${dialog} sl-button[name="submit"]`).click();
  await page.waitForSelector(`${dialog}:not([open])`, { timeout: 15000 });
}

const program = new Command()
  .name('ui-screenshot')
  .description('Build the demo container from the current checkout, log in, and take a screenshot')
  .option('--out <file>', 'screenshot file', 'ui-screenshot.png')
  .option('--user <name>', 'login user', 'admin')
  .option('--password <password>', 'login password', 'admin')
  .option('--click <selector>', 'CSS selector to click before the screenshot (repeatable, in order)', (v, prev) => [...prev, v], /** @type {string[]} */ ([]))
  .option('--mock <spec>', 'mock an API response: <url glob>=<JSON route.fulfill options or file> (repeatable)', (v, prev) => [...prev, v], /** @type {string[]} */ ([]))
  .option('--width <px>', 'viewport width', '1400')
  .option('--height <px>', 'viewport height', '900')
  .option('--wait <ms>', 'delay after login and after each click', '1000')
  .option('--base-url <url>', 'use a running instance instead of starting a container')
  .option('--no-build', 'reuse the existing image for the tag instead of rebuilding')
  .option('--tag <tag>', 'image tag', 'ui-screenshot')
  .option('--keep', 'keep the container and image afterwards');

program.parse();
const opts = program.opts();
const name = `pte-${opts.tag}`;
let baseUrl = opts.baseUrl;

try {
  if (!baseUrl) {
    const port = await getFreePort();
    container(['start', ...(opts.build ? ['--rebuild'] : []), '--tag', opts.tag, '--name', name, '--port', String(port)]);
    baseUrl = `http://localhost:${port}`;
  }

  await waitForServer(baseUrl);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: Number(opts.width), height: Number(opts.height) } });
    page.on('console', msg => msg.type() === 'error' && console.log(`[browser error] ${msg.text()}`));
    for (const spec of opts.mock) await addMock(page, spec);
    await page.goto(baseUrl);
    await login(page, opts.user, opts.password);
    await page.waitForTimeout(Number(opts.wait) * 3);
    for (const selector of opts.click) {
      await page.locator(selector).first().click();
      await page.waitForTimeout(Number(opts.wait));
    }
    const out = path.resolve(opts.out);
    await page.screenshot({ path: out });
    console.log(`Screenshot written to ${out}`);
  } finally {
    await browser.close();
  }
} finally {
  if (!opts.baseUrl && !opts.keep) {
    container(['stop', '--name', name, '--remove'], true);
    try {
      execFileSync('podman', ['rmi', `pdf-tei-editor:${opts.tag}`], { stdio: 'ignore' });
    } catch {
      try {
        execFileSync('docker', ['rmi', `pdf-tei-editor:${opts.tag}`], { stdio: 'ignore' });
      } catch { /* image already gone or no container tool */ }
    }
  }
}
