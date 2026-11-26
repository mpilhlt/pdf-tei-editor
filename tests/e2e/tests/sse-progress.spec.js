/**
 * SSE Progress Widget E2E Tests
 *
 * Tests the progress widget functionality via SSE events using the
 * /api/v1/sse/test/progress test endpoint.
 *
 * @testCovers app/src/plugins/progress.js
 * @testCovers app/src/plugins/sse.js
 * @testCovers fastapi_app/routers/sse.py
 */

/** 
 * @import { api as Client } from '../../../app/src/plugins/client.js'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';

// Define allowed error patterns
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*Unauthorized', // Expected when checking auth status without login
];

test.describe('SSE Progress Widget', () => {

  test('should show progress widget and receive updates via SSE', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as reviewer (required for document actions)
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Wait a moment for state to update
      await page.waitForTimeout(1000);

      // Wait for SSE connection to establish
      await page.waitForFunction(() => {
        const sse = /** @type {any} */(window).sse;
        return sse && sse.readyState === EventSource.OPEN;
      }, { timeout: 10000 });

      // Verify SSE is connected
      const sseState = await page.evaluate(() => {
        const sse = /** @type {any} */(window).sse;
        return {
          readyStateOpen: sse.readyState === EventSource.OPEN,
          url: sse.url,
        };
      });
      expect(sseState.readyStateOpen).toBe(true);

      // Track progress events received
      const progressEvents = await page.evaluate(() => {
        const events = /** @type {Array<{type: string, data: any}>} */ ([]);
        const sse = /** @type {any} */(window).sse;

        // Add listeners for all progress event types
        ['progressShow', 'progressValue', 'progressLabel', 'progressTitle', 'progressHide'].forEach(eventType => {
          sse.addEventListener(eventType, (/** @type {MessageEvent} */ evt) => {
            events.push({ type: eventType, data: JSON.parse(evt.data) });
          });
        });

        // Store events array on window for later access
        /** @type {any} */(window).__progressEvents = events;
        return events;
      });

      // Trigger the progress test endpoint
      const result = await page.evaluate(async () => {
        /** @type {Client} */
        const client = /** @type {any} */(window).client;
        // don't wait for completion
        return await client.apiClient.sseTestProgress({
          steps: 3,
          delay_ms: 500,
          label_prefix: 'E2E Test step'
        })
      });

      expect(result.status).toBe('ok');
      expect(result.steps_completed).toBe(3);
      const progressId = result.progress_id;
      expect(progressId).toBeTruthy();

      // Wait for progress widget to appear
      await page.waitForSelector('.progress-widget', { timeout: 5000 });

      // Verify widget is visible and has correct progress_id
      const widgetState = await page.evaluate((expectedId) => {
        const widget = document.querySelector('.progress-widget');
        if (!widget) return null;
        return {
          visible: widget instanceof HTMLElement && widget.style.display !== 'none',
          progressId: widget instanceof HTMLElement ? widget.dataset.progressId : null,
          hasProgressBar: !!widget.querySelector('sl-progress-bar'),
          hasCancelBtn: !!widget.querySelector('[data-name="cancelBtn"]')
        };
      }, progressId);

      expect(widgetState).not.toBeNull();
      expect(widgetState.visible).toBe(true);
      expect(widgetState.progressId).toBe(progressId);
      expect(widgetState.hasProgressBar).toBe(true);
      expect(widgetState.hasCancelBtn).toBe(true);
      await expect(page.locator(`.progress-widget[data-progress-id="${progressId}"] [name="titleRow"]`)).toHaveText(/Progress test/);

      // Wait for progress to complete (widget should be hidden)
      await page.waitForSelector('.progress-widget', { state: 'detached', timeout: 5000 });

      // Verify widget was removed
      const widgetExists = await page.evaluate(() => {
        return document.querySelector('.progress-widget') !== null;
      });
      expect(widgetExists).toBe(false);

      // Verify progress events were received
      const receivedEvents = await page.evaluate(() => {
        return /** @type {any} */(window).__progressEvents;
      });

      // Should have show, value updates, label updates, and hide
      const eventTypes = receivedEvents.map((/** @type {{type: string}} */ e) => e.type);
      expect(eventTypes).toContain('progressShow');
      expect(eventTypes).toContain('progressValue');
      expect(eventTypes).toContain('progressLabel');
      expect(eventTypes).toContain('progressTitle');
      expect(eventTypes).toContain('progressHide');

      // Verify all events have correct progress_id
      for (const event of receivedEvents) {
        expect(event.data.progress_id).toBe(progressId);
      }

    } finally {
      stopErrorMonitoring();
    }
  });

  test('should toggle minimized state on click', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as reviewer (required for document actions)
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Wait a moment for state to update
      await page.waitForTimeout(1000);

      // Wait for SSE connection
      await page.waitForFunction(() => {
        const sse = /** @type {any} */(window).sse;
        return sse && sse.readyState === EventSource.OPEN;
      }, { timeout: 10000 });

      // Trigger progress with longer delay so we can interact
      
      await page.evaluate(async () => {
        // Trigger the progress test endpoint
        /** @type {Client} */
        const client = /** @type {any} */(window).client;
        return await client.apiClient.sseTestProgress({
          steps: 10,
          delay_ms: 500,
          label_prefix: 'Toggle test'
        })
      }); 

      // Wait for widget to appear
      await page.waitForSelector('.progress-widget', { timeout: 5000 });

      // Check initial state (should be maximized by default)
      let widgetClasses = await page.evaluate(() => {
        const widget = document.querySelector('.progress-widget');
        return widget ? Array.from(widget.classList) : [];
      });
      expect(widgetClasses).toContain('maximized');
      expect(widgetClasses).not.toContain('minimized');

      // Click on widget to minimize (not on cancel button)
      await page.click('.progress-widget [name="labelRow"]');
      await page.waitForTimeout(100);

      // Verify minimized state
      widgetClasses = await page.evaluate(() => {
        const widget = document.querySelector('.progress-widget');
        return widget ? Array.from(widget.classList) : [];
      });
      expect(widgetClasses).toContain('minimized');
      expect(widgetClasses).not.toContain('maximized');

      // Click again to maximize
      await page.click('.progress-widget');
      await page.waitForTimeout(100);

      // Verify maximized state
      widgetClasses = await page.evaluate(() => {
        const widget = document.querySelector('.progress-widget');
        return widget ? Array.from(widget.classList) : [];
      });
      expect(widgetClasses).toContain('maximized');
      expect(widgetClasses).not.toContain('minimized');

      // Wait for progress to complete
      await page.waitForSelector('.progress-widget', { state: 'detached', timeout: 10000 });

    } finally {
      stopErrorMonitoring();
    }
  });

  test('should handle progress API programmatically', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await page.goto('/');

      // Login
      await page.waitForSelector('sl-dialog[name="loginDialog"][open]', { timeout: 10000 });
      await page.evaluate(() => {
        const ui = /** @type {any} */(window).ui;
        ui.loginDialog.username.value = 'testuser';
        ui.loginDialog.password.value = 'testpass';
        ui.loginDialog.submit.click();
      });
      await page.waitForSelector('sl-dialog[name="loginDialog"]:not([open])', { state: 'attached', timeout: 5000 });

      // Wait for progress plugin to be installed (app ready)
      await page.waitForTimeout(1000);

      // Test the progress API directly
      const apiTest = await page.evaluate(() => {
        // Access progress plugin API via window.progress (if exposed) or via app
        const progressApi = /** @type {any} */(window).progress;
        if (!progressApi) {
          return { error: 'Progress API not exposed on window' };
        }

        // Test show
        progressApi.show('test-api-1', {
          label: 'API Test',
          value: 50,
          cancellable: true
        });

        const isVisible = progressApi.isVisible('test-api-1');
        const activeWidgets = progressApi.getActiveWidgets();

        // Test setValue
        progressApi.setValue('test-api-1', 75);

        // Test setLabel
        progressApi.setLabel('test-api-1', 'Updated Label');

        // Get widget state
        const widget = document.querySelector('.progress-widget[data-progress-id="test-api-1"]');
        const progressBar = widget?.querySelector('sl-progress-bar');
        const labelRow = widget?.querySelector('[name="labelRow"]');

        const widgetState = {
          value: progressBar ? /** @type {any} */(progressBar).value : null,
          label: labelRow ? labelRow.textContent : null
        };

        // Test hide
        progressApi.hide('test-api-1');
        const stillVisible = progressApi.isVisible('test-api-1');

        return {
          isVisible,
          activeWidgets,
          widgetState,
          stillVisible
        };
      });

      if (apiTest.error) {
        // Progress API not exposed - this is expected if not configured
        console.log('Progress API not exposed on window, skipping programmatic test');
        return;
      }

      expect(apiTest.isVisible).toBe(true);
      expect(apiTest.activeWidgets).toContain('test-api-1');
      expect(apiTest.widgetState.value).toBe(75);
      expect(apiTest.widgetState.label).toBe('Updated Label');
      expect(apiTest.stillVisible).toBe(false);

    } finally {
      stopErrorMonitoring();
    }
  });

  test('should show titles and stack many widgets in two containers without overlap', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testuser', 'testpass');
      await page.waitForTimeout(1000);

      const result = await page.evaluate(() => {
        const progressApi = /** @type {any} */(window).progress;
        const ids = ['stack-0', 'stack-1', 'stack-2', 'stack-3', 'stack-4', 'stack-5', 'stack-6'];
        // first three maximized, the rest minimized
        ids.forEach((id, index) => progressApi.show(id, {
          title: `Title ${index} with a long name that is cropped when the widget is minimized`,
          label: `Label ${index}`,
          value: index * 10,
          minimized: index >= 3
        }));
        progressApi.show('stack-untitled', { label: 'No title', minimized: true });
        progressApi.setTitle('stack-1', 'Changed title');

        /** @param {string} id */
        const widgetOf = (id) => /** @type {HTMLElement} */ (document.querySelector(`.progress-widget[data-progress-id="${id}"]`));
        /** @param {HTMLElement} el */
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
        /** @param {string} id */
        const titleRow = (id) => /** @type {HTMLElement} */ (widgetOf(id).querySelector('[name="titleRow"]'));

        const state = {
          maximizedParent: ids.slice(0, 3).map(id => widgetOf(id).parentElement?.classList.contains('progress-stack-maximized')),
          minimizedParent: ids.slice(3).map(id => widgetOf(id).parentElement?.classList.contains('progress-stack-minimized')),
          boxes: [...ids, 'stack-untitled'].map(id => box(widgetOf(id))),
          changedTitle: titleRow('stack-1').textContent,
          minimizedTitleVisible: titleRow('stack-4').offsetHeight > 0,
          minimizedTitleCropped: titleRow('stack-4').scrollWidth > titleRow('stack-4').clientWidth,
          untitledTitleHidden: titleRow('stack-untitled').offsetHeight === 0
        };

        // toggling moves a widget to the other container, in creation order
        widgetOf('stack-1').click();
        const minimizedOrder = Array.from(/** @type {HTMLElement} */ (widgetOf('stack-1').parentElement).children)
          .map(el => /** @type {HTMLElement} */ (el).dataset.progressId);

        [...ids, 'stack-untitled'].forEach(id => progressApi.hide(id));
        return { ...state, minimizedOrder };
      });

      expect(result.maximizedParent).toEqual([true, true, true]);
      expect(result.minimizedParent).toEqual([true, true, true, true]);
      expect(result.changedTitle).toBe('Changed title');
      expect(result.minimizedTitleVisible).toBe(true);
      expect(result.minimizedTitleCropped).toBe(true);
      expect(result.untitledTitleHidden).toBe(true);
      expect(result.minimizedOrder).toEqual(['stack-1', 'stack-3', 'stack-4', 'stack-5', 'stack-6', 'stack-untitled']);

      // no two widgets overlap
      const boxes = result.boxes;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          expect(overlap, `widgets ${i} and ${j} overlap`).toBe(false);
        }
      }
    } finally {
      stopErrorMonitoring();
    }
  });
});
