#!/usr/bin/env node

/**
 * Named parts and copy of the "Propose upstream" sub-dialog of the
 * document-rules resource editor.
 *
 * @testCovers app/src/templates/document-rules-propose-dialog.html
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createNavigableElement } from '../../../app/src/modules/navigable-element.js';

const templatePath = fileURLToPath(
  new URL('../../../app/src/templates/document-rules-propose-dialog.html', import.meta.url)
);
const templateHtml = readFileSync(templatePath, 'utf-8');

function load() {
  const dom = new JSDOM(`<!DOCTYPE html><body>${templateHtml}</body>`);
  // navigable-element.js references the global `Node` constant
  global.Node = dom.window.Node;
  const dialog = dom.window.document.querySelector('sl-dialog');
  return { dialog, root: createNavigableElement(dialog) };
}

describe('document-rules-propose-dialog.html', () => {
  it('is the documentRulesProposeDialog with its label and width', () => {
    const { dialog } = load();
    assert.strictEqual(dialog.getAttribute('name'), 'documentRulesProposeDialog');
    assert.strictEqual(dialog.getAttribute('label'), 'Propose upstream');
    assert.match(dialog.getAttribute('style'), /--width: 80vw;/);
  });

  it('has the two layer checkboxes', () => {
    const { root } = load();
    assert.strictEqual(root.includeHuman.tagName, 'SL-CHECKBOX');
    assert.strictEqual(root.includeHuman.textContent.trim(), 'Guide section (human)');
    assert.strictEqual(root.includeMachine.tagName, 'SL-CHECKBOX');
    assert.strictEqual(root.includeMachine.textContent.trim(), 'Machine rules');
  });

  it('has a hidden notice, a files container and the apply hint', () => {
    const { root } = load();
    assert.strictEqual(root.notice.tagName, 'DIV');
    assert.strictEqual(root.notice.style.display, 'none');
    assert.strictEqual(root.files.tagName, 'DIV');
    assert.strictEqual(root.hint.textContent.trim(), 'Apply the patch in a clone of the guide repository with "git apply <file>", then commit and open a pull request.');
  });

  it('has a disabled download button and a close button in the footer', () => {
    const { root } = load();
    assert.strictEqual(root.downloadBtn.textContent.trim(), 'Download patch');
    assert.ok(root.downloadBtn.hasAttribute('disabled'));
    assert.strictEqual(root.downloadBtn.parentElement.getAttribute('slot'), 'footer');
    assert.strictEqual(root.closeBtn.textContent.trim(), 'Close');
    assert.strictEqual(root.closeBtn.parentElement.getAttribute('slot'), 'footer');
  });
});
