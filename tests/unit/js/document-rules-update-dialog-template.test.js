#!/usr/bin/env node

/**
 * Named parts and copy of the "Update machine rules from guide" sub-dialog
 * of the document-rules resource editor.
 *
 * @testCovers app/src/templates/document-rules-update-dialog.html
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createNavigableElement } from '../../../app/src/modules/navigable-element.js';

const templatePath = fileURLToPath(
  new URL('../../../app/src/templates/document-rules-update-dialog.html', import.meta.url)
);
const templateHtml = readFileSync(templatePath, 'utf-8');

function load() {
  const dom = new JSDOM(`<!DOCTYPE html><body>${templateHtml}</body>`);
  // navigable-element.js references the global `Node` constant
  global.Node = dom.window.Node;
  const dialog = dom.window.document.querySelector('sl-dialog');
  return { dialog, root: createNavigableElement(dialog) };
}

describe('document-rules-update-dialog.html', () => {
  it('is the documentRulesUpdateDialog with its label and width', () => {
    const { dialog } = load();
    assert.strictEqual(dialog.getAttribute('name'), 'documentRulesUpdateDialog');
    assert.strictEqual(dialog.getAttribute('label'), 'Update machine rules from guide');
    assert.match(dialog.getAttribute('style'), /--width: 80vw;/);
  });

  it('exposes the notice, the guide change and the model row', () => {
    const { root } = load();
    assert.strictEqual(root.notice.tagName, 'DIV');
    assert.strictEqual(root.humanDiffHeading.textContent.trim(), 'Change in the guide');
    assert.strictEqual(root.humanDiff.tagName, 'DIV');
    assert.strictEqual(root.modelRow.modelSelect.tagName, 'SL-SELECT');
    assert.strictEqual(root.modelRow.modelSelect.getAttribute('size'), 'small');
    assert.strictEqual(root.modelRow.generateBtn.textContent.trim(), 'Generate');
    assert.strictEqual(root.modelRow.generateBtn.getAttribute('variant'), 'primary');
  });

  it('hides the proposal until a result exists', () => {
    const { root } = load();
    assert.strictEqual(root.proposedHeading.textContent.trim(), 'Proposed machine rules');
    assert.strictEqual(root.proposedHeading.style.display, 'none');
    assert.strictEqual(root.proposedDiff.style.display, 'none');
  });

  it('has a disabled accept button and a close button in the footer', () => {
    const { root } = load();
    assert.strictEqual(root.acceptBtn.textContent.trim(), 'Accept as new override');
    assert.ok(root.acceptBtn.hasAttribute('disabled'));
    assert.strictEqual(root.acceptBtn.parentElement.getAttribute('slot'), 'footer');
    assert.strictEqual(root.closeBtn.textContent.trim(), 'Close');
    assert.strictEqual(root.closeBtn.parentElement.getAttribute('slot'), 'footer');
  });
});
