#!/usr/bin/env node

/**
 * Regression test for the document-rules resource editor dialog's tab
 * markup: Shoelace's <sl-tab-group> matches each <sl-tab panel="X"> to the
 * <sl-tab-panel> whose *own* `name` attribute equals X (see
 * @shoelace-style/shoelace's tab-group component, which does
 * `this.panels.find(el => el.name === tab.panel)`) - not to this app's
 * `name`-as-navigation-label convention (see navigable-element.js). Using
 * the app's own nav label ("editPanel"/"previewPanel") as the Shoelace
 * `name` broke that match silently: neither tab panel was ever considered
 * "active", so both stayed `display: none` regardless of which tab looked
 * selected, in the edit AND the preview tab. Fixed by giving <sl-tab-panel>
 * the Shoelace-required `name` and moving the app's own label to
 * `data-name` (see navigable-element.js's `skipNameAttrTags`).
 *
 * @testCovers app/src/templates/document-rules-editor-dialog.html
 * @testCovers app/src/modules/navigable-element.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createNavigableElement } from '../../../app/src/modules/navigable-element.js';

const templatePath = fileURLToPath(
  new URL('../../../app/src/templates/document-rules-editor-dialog.html', import.meta.url)
);
const templateHtml = readFileSync(templatePath, 'utf-8');

describe('document-rules-editor-dialog.html tab markup', () => {
  it('every <sl-tab panel="X"> has a matching <sl-tab-panel name="X"> (the Shoelace-required pairing)', () => {
    const dom = new JSDOM(`<!DOCTYPE html><body>${templateHtml}</body>`);
    const document = dom.window.document;
    const tabs = [...document.querySelectorAll('sl-tab')];
    const panels = [...document.querySelectorAll('sl-tab-panel')];
    assert.ok(tabs.length > 0, 'fixture must contain at least one <sl-tab>');
    const panelNames = panels.map((p) => p.getAttribute('name'));
    for (const tab of tabs) {
      const target = tab.getAttribute('panel');
      assert.ok(
        panelNames.includes(target),
        `<sl-tab panel="${target}"> has no matching <sl-tab-panel name="${target}">`
      );
    }
  });

  it('still exposes editPanel/previewPanel to this app\'s own name-based navigation via data-name', () => {
    const dom = new JSDOM(`<!DOCTYPE html><body>${templateHtml}</body>`);
    const document = dom.window.document;
    // navigable-element.js references the global `Node` constant (e.g.
    // Node.ELEMENT_NODE) - provide jsdom's for the duration of this call.
    global.Node = dom.window.Node;
    const root = createNavigableElement(document.querySelector('sl-dialog'));
    assert.ok(root.textBody.textTabs.editPanel, 'textBody.textTabs.editPanel must resolve');
    assert.ok(root.textBody.textTabs.previewPanel, 'textBody.textTabs.previewPanel must resolve');
    assert.strictEqual(root.textBody.textTabs.editPanel.getAttribute('name'), 'edit');
    assert.strictEqual(root.textBody.textTabs.previewPanel.getAttribute('name'), 'preview');
  });
});
