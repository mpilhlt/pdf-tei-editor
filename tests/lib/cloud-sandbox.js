/**
 * Adjustments for running the E2E tests in the Claude Code cloud sandbox.
 *
 * The sandbox ships an older Chromium (/opt/pw-browsers/chromium) than the
 * pinned Playwright expects and cannot download browsers. That Chromium also
 * lacks Map.prototype.getOrInsertComputed, which the bundled PDF.js needs, so
 * the PDF viewer fails to initialize. Outside the sandbox these helpers do
 * nothing.
 */

/**
 * @import { BrowserContext } from '@playwright/test'
 */

import { existsSync } from 'fs';

/** Chromium preinstalled in the cloud sandbox */
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';

/** True when running in the Claude Code cloud sandbox */
export const IS_CLOUD_SANDBOX = process.env.CLAUDE_CODE_REMOTE === 'true' && existsSync(SANDBOX_CHROMIUM);

/**
 * Chromium launch options for the sandbox, or an empty object elsewhere.
 * @returns {{executablePath?: string}}
 */
export function sandboxChromiumLaunchOptions() {
  return IS_CLOUD_SANDBOX ? { executablePath: SANDBOX_CHROMIUM } : {};
}

/**
 * Browser-side polyfill for Map/WeakMap.prototype.getOrInsert(Computed),
 * passed to BrowserContext.addInitScript() in the sandbox.
 */
export function upsertPolyfill() {
  for (const Ctor of [Map, WeakMap]) {
    const proto = Ctor.prototype;
    if (!proto.getOrInsert) {
      Object.defineProperty(proto, 'getOrInsert', {
        configurable: true,
        writable: true,
        value(key, value) {
          if (!this.has(key)) this.set(key, value);
          return this.get(key);
        }
      });
    }
    if (!proto.getOrInsertComputed) {
      Object.defineProperty(proto, 'getOrInsertComputed', {
        configurable: true,
        writable: true,
        value(key, callback) {
          if (!this.has(key)) this.set(key, callback(key));
          return this.get(key);
        }
      });
    }
  }
}

/** Marks contexts that prepareSandboxContext() already handled */
const PREPARED = Symbol('cloud-sandbox-prepared');

/**
 * Install the upsert polyfill into a browser context: as an init script for
 * pages, and prepended to the PDF.js worker script, which init scripts do not
 * reach. No-op outside the sandbox or if the context was already prepared.
 * @param {BrowserContext} context
 * @returns {Promise<void>}
 */
export async function prepareSandboxContext(context) {
  if (!IS_CLOUD_SANDBOX || context[PREPARED]) return;
  context[PREPARED] = true;
  await context.addInitScript(upsertPolyfill);
  await context.route('**/pdfjs/build/pdf.worker.mjs', async route => {
    const response = await route.fetch();
    const body = `(${upsertPolyfill.toString()})();\n${await response.text()}`;
    await route.fulfill({ response, body });
  });
}
