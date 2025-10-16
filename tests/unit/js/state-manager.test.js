/**
 * Unit tests for StateManager
 * Tests pure state operations, history tracking, and persistence
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import StateManager from '../../app/src/modules/state-manager.js';

describe('StateManager', () => {
  let stateManager;
  let initialState;
  
  beforeEach(() => {
    stateManager = new StateManager();
    initialState = {
      pdf: null,
      xml: null,
      user: null,
      ext: {}
    };
  });

  describe('Constructor', () => {
    it('should create state manager with default settings', () => {
      const sm = new StateManager();
      assert.strictEqual(sm.preserveStateEnabled, false);
      assert.deepStrictEqual(sm.persistedStateVars, []);
    });
  });

  describe('Pure State Operations', () => {
    it('should apply state changes immutably', () => {
      const { newState, changedKeys } = stateManager.applyStateChanges(initialState, {
        pdf: 'document.pdf',
        user: { name: 'test' }
      });
      
      // Original state unchanged
      assert.strictEqual(initialState.pdf, null);
      assert.strictEqual(initialState.user, null);
      
      // New state has changes
      assert.strictEqual(newState.pdf, 'document.pdf');
      assert.deepStrictEqual(newState.user, { name: 'test' });
      assert.deepStrictEqual(changedKeys, ['pdf', 'user']);
    });

    it('should handle no changes', () => {
      const { newState, changedKeys } = stateManager.applyStateChanges(initialState, {});
      
      assert.notStrictEqual(newState, initialState); // Still creates new object
      assert.deepStrictEqual(changedKeys, []);
    });

    it('should preserve unchanged properties', () => {
      const stateWithData = {
        ...initialState,
        pdf: 'existing.pdf',
        xml: 'existing.xml'
      };
      
      const { newState } = stateManager.applyStateChanges(stateWithData, {
        user: { name: 'test' }
      });
      
      assert.strictEqual(newState.pdf, 'existing.pdf');
      assert.strictEqual(newState.xml, 'existing.xml');
      assert.deepStrictEqual(newState.user, { name: 'test' });
    });
  });

  describe('Extension State Operations', () => {
    it('should apply extension changes', () => {
      const { newState, changedKeys } = stateManager.applyExtensionChanges(initialState, {
        myPlugin: { data: 'test' }
      });
      
      assert.deepStrictEqual(newState.ext.myPlugin, { data: 'test' });
      assert.deepStrictEqual(changedKeys, ['ext']);
    });

    it('should merge extension properties', () => {
      const stateWithExt = {
        ...initialState,
        ext: { existing: { value: 1 } }
      };
      
      const { newState } = stateManager.applyExtensionChanges(stateWithExt, {
        myPlugin: { data: 'test' }
      });
      
      assert.deepStrictEqual(newState.ext, {
        existing: { value: 1 },
        myPlugin: { data: 'test' }
      });
    });
  });

  describe('State History', () => {
    it('should track state history using WeakMap', () => {
      const { newState: state1 } = stateManager.applyStateChanges(initialState, {
        pdf: 'doc1.pdf'
      });
      
      const { newState: state2 } = stateManager.applyStateChanges(state1, {
        xml: 'doc1.xml'
      });
      
      // Can access previous states
      assert.strictEqual(stateManager.getPreviousState(state2), state1);
      assert.strictEqual(stateManager.getPreviousState(state1), initialState);
      assert.strictEqual(stateManager.getPreviousState(initialState), undefined);
    });

    it('should detect state changes', () => {
      const { newState: state1 } = stateManager.applyStateChanges(initialState, {
        pdf: 'doc1.pdf',
        user: { name: 'test' }
      });
      
      assert.strictEqual(stateManager.hasStateChanged(state1, 'pdf'), true);
      assert.strictEqual(stateManager.hasStateChanged(state1, 'user'), true);
      assert.strictEqual(stateManager.hasStateChanged(state1, 'xml'), false);
      assert.strictEqual(stateManager.hasStateChanged(state1, 'pdf', 'xml'), true);
    });

    it('should get changed state keys', () => {
      const { newState } = stateManager.applyStateChanges(initialState, {
        pdf: 'doc1.pdf',
        user: { name: 'test' }
      });
      
      const changedKeys = stateManager.getChangedStateKeys(newState);
      assert.deepStrictEqual(changedKeys.sort(), ['pdf', 'user']);
    });

    it('should get previous state values', () => {
      const stateWithData = {
        ...initialState,
        pdf: 'old.pdf'
      };
      
      const { newState } = stateManager.applyStateChanges(stateWithData, {
        pdf: 'new.pdf'
      });
      
      assert.strictEqual(stateManager.getPreviousStateValue(newState, 'pdf'), 'old.pdf');
      assert.strictEqual(stateManager.getPreviousStateValue(newState, 'xml'), null);
    });

    it('should handle nested property paths', () => {
      const stateWithNested = {
        ...initialState,
        ext: { plugin: { value: 'old' } }
      };
      
      const { newState } = stateManager.applyStateChanges(stateWithNested, {
        ext: { plugin: { value: 'new' } }
      });
      
      assert.strictEqual(
        stateManager.getPreviousStateValue(newState, 'ext.plugin.value'), 
        'old'
      );
    });
  });

  describe('State Persistence', () => {
    beforeEach(() => {
      // Mock sessionStorage
      global.sessionStorage = {
        storage: {},
        setItem(key, value) { this.storage[key] = value; },
        getItem(key) { return this.storage[key] || null; },
        clear() { this.storage = {}; }
      };
    });

    it('should save state to session storage when enabled', () => {
      stateManager.preserveState(true, ['pdf', 'user']);
      
      const { newState } = stateManager.applyStateChanges(initialState, {
        pdf: 'doc1.pdf',
        user: { name: 'test' },
        xml: 'doc1.xml' // This should not be persisted
      });
      
      const saved = JSON.parse(global.sessionStorage.getItem('pdf-tei-editor.state'));
      assert.deepStrictEqual(saved, {
        pdf: 'doc1.pdf',
        user: { name: 'test' }
      });
    });

    it('should load state from session storage', () => {
      const testState = { pdf: 'saved.pdf', user: { name: 'saved' } };
      global.sessionStorage.setItem('pdf-tei-editor.state', JSON.stringify(testState));
      
      const loadedState = stateManager.getStateFromSessionStorage();
      assert.deepStrictEqual(loadedState, testState);
    });

    it('should handle storage errors gracefully', () => {
      // Mock storage error
      global.sessionStorage.setItem = () => { throw new Error('Storage full'); };
      
      stateManager.preserveState(true);
      
      // Should not throw
      const { newState } = stateManager.applyStateChanges(initialState, {
        pdf: 'doc1.pdf'
      });
      
      assert.strictEqual(newState.pdf, 'doc1.pdf');
    });
  });

  describe('Utility Methods', () => {
    it('should handle nested property access', () => {
      const obj = {
        level1: {
          level2: {
            value: 'found'
          }
        }
      };
      
      assert.strictEqual(stateManager.getNestedProperty(obj, 'level1.level2.value'), 'found');
      assert.strictEqual(stateManager.getNestedProperty(obj, 'level1.missing'), undefined);
      assert.strictEqual(stateManager.getNestedProperty(obj, 'missing.path'), undefined);
    });
  });
});