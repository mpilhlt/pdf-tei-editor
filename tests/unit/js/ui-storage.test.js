/**
 * Unit tests for UIStorage
 * @testCovers app/src/modules/ui-storage.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Minimal localStorage stub
function makeStorage() {
  const data = {};
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

// Minimal EventTarget stub
function makeElement(initialProps = {}) {
  const handlers = {};
  return {
    ...initialProps,
    addEventListener: (event, fn) => { handlers[event] = fn; },
    removeEventListener: (event, fn) => { if (handlers[event] === fn) delete handlers[event]; },
    _emit: (event) => handlers[event]?.(),
    _handlers: handlers,
  };
}

// Import after mocking (dynamic import to allow for the module to be tested)
const { UIStorage } = await import('../../../app/src/modules/ui-storage.js');

describe('UIStorage', () => {
  let storage;
  let ui;

  beforeEach(() => {
    storage = makeStorage();
    ui = new UIStorage('myplugin', storage);
  });

  describe('get / set / remove', () => {
    it('returns defaultValue when key is absent', () => {
      assert.strictEqual(ui.get('foo', 42), 42);
    });

    it('returns undefined when no default given and key absent', () => {
      assert.strictEqual(ui.get('foo'), undefined);
    });

    it('stores and retrieves a string', () => {
      ui.set('foo', 'bar');
      assert.strictEqual(ui.get('foo'), 'bar');
    });

    it('stores and retrieves a boolean', () => {
      ui.set('flag', true);
      assert.strictEqual(ui.get('flag'), true);
    });

    it('stores and retrieves a number', () => {
      ui.set('pos', 42.5);
      assert.strictEqual(ui.get('pos'), 42.5);
    });

    it('namespaces keys as ui.<namespace>.<key>', () => {
      ui.set('mykey', 'val');
      assert.strictEqual(storage._data['ui.myplugin.mykey'], '"val"');
    });

    it('remove deletes the key', () => {
      ui.set('foo', 1);
      ui.remove('foo');
      assert.strictEqual(ui.get('foo'), undefined);
    });

    it('returns raw string if value is not valid JSON (legacy compat)', () => {
      storage.setItem('ui.myplugin.legacy', 'not-json-{');
      assert.strictEqual(ui.get('legacy'), 'not-json-{');
    });
  });

  describe('bind()', () => {
    it('restores stored value to element property on bind', () => {
      ui.set('pos', 75);
      const el = makeElement({ position: 50 });
      ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 50 });
      assert.strictEqual(el.position, 75);
    });

    it('uses default value when nothing stored', () => {
      const el = makeElement({ position: 0 });
      ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 33 });
      assert.strictEqual(el.position, 33);
    });

    it('saves element property to storage on event', () => {
      const el = makeElement({ position: 50 });
      ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 50 });
      el.position = 70;
      el._emit('sl-reposition');
      assert.strictEqual(ui.get('pos'), 70);
    });

    it('returns unbind function that stops saving', () => {
      const el = makeElement({ position: 50 });
      const unbind = ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 50 });
      unbind();
      el.position = 99;
      el._emit('sl-reposition');
      assert.strictEqual(ui.get('pos', 50), 50); // unchanged
    });
  });
});
