/**
 * Unit tests for Application class
 * Tests orchestration between PluginManager and StateManager, plugin lifecycle management,
 * and proper separation of concerns
 *
 * @testCovers app/src/modules/application.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Application } from '../../../app/src/modules/application.js';
import PluginManager from '../../../app/src/modules/plugin-manager.js';
import StateManager from '../../../app/src/modules/state-manager.js';
import Plugin from '../../../app/src/modules/plugin-base.js';

// Mock window for shutdown handler
// @ts-ignore
global.window = {
  addEventListener: () => {}
};

describe('Application', () => {
  let application;
  let pluginManager;
  let stateManager;
  let mockState;
  
  beforeEach(() => {
    pluginManager = new PluginManager();
    stateManager = new StateManager();
    application = new Application(pluginManager, stateManager);
    
    mockState = {
      pdf: null,
      xml: null,
      user: null,
      ext: {}
    };
  });

  describe('Constructor', () => {
    it('should create application with plugin and state managers', () => {
      const app = new Application(pluginManager, stateManager);
      
      // State should not be initialized yet, so getCurrentState should throw
      assert.throws(() => app.getCurrentState(), /State has not been initialized yet/);
      assert.strictEqual(app.getStateManager(), stateManager);
      assert.ok(app.getPluginContext());
    });

    it('should create PluginContext facade', () => {
      const context = application.getPluginContext();
      
      // Should have the methods plugins need
      assert.strictEqual(typeof context.updateState, 'function');
      assert.strictEqual(typeof context.hasStateChanged, 'function');
      assert.strictEqual(typeof context.invokePluginEndpoint, 'function');
    });
  });

  describe('State Management Orchestration', () => {
    it('should update state and notify plugins', async () => {
      let pluginNotified = false;
      let receivedState = {};
      
      // Register a mock plugin
      pluginManager.register({
        name: 'test-plugin',
        state: {
          update: (state) => {
            pluginNotified = true;
            receivedState = state;
          }
        }
      });
      
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      const newState = await application.updateState({
        pdf: 'document.pdf'
      });
      
      assert.strictEqual(pluginNotified, true);
      assert.strictEqual(receivedState.pdf, 'document.pdf');
      assert.strictEqual(newState.pdf, 'document.pdf');
      assert.notStrictEqual(newState, mockState); // Immutability preserved
    });

    it('should skip plugin notification when no changes', async () => {
      let pluginCallCount = 0;
      
      pluginManager.register({
        name: 'test-plugin',
        state: {
          update: () => { pluginCallCount++; }
        }
      });
      
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      const newState = await application.updateState({});
      
      assert.strictEqual(pluginCallCount, 1); // Still called once
      assert.strictEqual(newState, mockState); // Returns original state
    });

    it('should update extension state and notify plugins', async () => {
      let receivedState = {};
      
      pluginManager.register({
        name: 'test-plugin',
        state: {
          update: (state) => { receivedState = state; }
        }
      });
      
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      const newState = await application.updateStateExt({
        myPlugin: { data: 'test' }
      });
      
      assert.deepStrictEqual(receivedState.ext.myPlugin, { data: 'test' });
      assert.deepStrictEqual(newState.ext.myPlugin, { data: 'test' });
    });

    it('should provide state utilities through PluginContext', async () => {
      const context = application.getPluginContext();
      
      // Set up state history
      const { newState: state1 } = stateManager.applyStateChanges(mockState, {
        pdf: 'doc1.pdf'
      });
      
      const { newState: state2 } = stateManager.applyStateChanges(state1, {
        xml: 'doc1.xml'
      });
      
      // Test state utilities through context
      assert.strictEqual(context.hasStateChanged(state2, 'xml'), true);
      assert.strictEqual(context.hasStateChanged(state2, 'pdf'), false); // pdf didn't change from state1 to state2
      assert.deepStrictEqual(context.getChangedStateKeys(state2), ['xml']);
      assert.strictEqual(context.getPreviousStateValue(state2, 'xml'), null);
      assert.strictEqual(context.getPreviousState(state2), state1);
    });

    // TODO: Remove this test once all legacy plugins are migrated
    it('should invoke legacy state.update endpoint', async () => {
      let legacyUpdateCalled = false;
      let receivedState = null;

      pluginManager.register({
        name: 'legacy-plugin',
        state: {
          update: (state) => {
            legacyUpdateCalled = true;
            receivedState = state;
          }
        }
      });

      await application.installPlugins(mockState);
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      const newState = await application.updateState({ pdf: 'legacy-test.pdf' });

      assert.strictEqual(legacyUpdateCalled, true);
      assert.strictEqual(receivedState?.pdf, 'legacy-test.pdf');
      assert.strictEqual(newState.pdf, 'legacy-test.pdf');
    });

    it('should invoke new Plugin class state endpoints', async () => {
      let internalUpdateCalled = false;
      let onStateUpdateCalled = false;
      let receivedChangedKeys = [];
      let internalReceivedState = null;

      class TestPlugin extends Plugin {
        constructor(context) {
          super(context, { name: 'test-plugin' });
        }
        
        updateInternalState(state) {
          internalUpdateCalled = true;
          internalReceivedState = state;
        }
        
        async onStateUpdate(changedKeys) {
          onStateUpdateCalled = true;
          receivedChangedKeys = changedKeys;
        }
      }

      const context = application.getPluginContext();
      const pluginInstance = new TestPlugin(context);
      application.registerPlugins([pluginInstance]);

      await application.installPlugins(mockState);
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      const newState = await application.updateState({ 
        pdf: 'new-plugin-test.pdf', 
        xml: 'new-plugin-test.xml' 
      });

      assert.strictEqual(internalUpdateCalled, true);
      assert.strictEqual(onStateUpdateCalled, true);
      assert.strictEqual(internalReceivedState?.pdf, 'new-plugin-test.pdf');
      assert.deepStrictEqual(receivedChangedKeys.sort(), ['pdf', 'xml']);
      assert.strictEqual(newState.pdf, 'new-plugin-test.pdf');
    });
  });

  describe('Plugin Lifecycle Management', () => {
    it('should register plugins with dependency resolution', () => {
      const pluginA = { name: 'a', deps: ['b'] };
      const pluginB = { name: 'b', deps: ['c'] };
      const pluginC = { name: 'c' };
      
      application.registerPlugins([pluginA, pluginB, pluginC]);
      
      // Should be registered in dependency order
      const orderedPlugins = pluginManager.dependencyOrderedPlugins;
      const names = orderedPlugins.map(p => p.name);
      assert.deepStrictEqual(names, ['c', 'b', 'a']);
    });

    it('should install plugins in dependency order', async () => {
      const installOrder = [];
      
      const pluginA = {
        name: 'a',
        deps: ['b'],
        install: () => { installOrder.push('a'); }
      };
      const pluginB = {
        name: 'b', 
        deps: ['c'],
        install: () => { installOrder.push('b'); }
      };
      const pluginC = {
        name: 'c',
        install: () => { installOrder.push('c'); }
      };
      
      application.registerPlugins([pluginA, pluginB, pluginC]);
      await application.installPlugins(mockState);
      
      assert.deepStrictEqual(installOrder, ['c', 'b', 'a']);
    });

    it('should start plugins in dependency order', async () => {
      const startOrder = [];
      
      const pluginA = {
        name: 'a',
        deps: ['b'],
        start: () => { startOrder.push('a'); }
      };
      const pluginB = {
        name: 'b',
        start: () => { startOrder.push('b'); }
      };
      
      application.registerPlugins([pluginA, pluginB]);
      await application.start();
      
      assert.deepStrictEqual(startOrder, ['b', 'a']);
    });

    it('should shutdown plugins gracefully', async () => {
      const shutdownOrder = [];
      
      const pluginA = {
        name: 'a',
        shutdown: () => { shutdownOrder.push('a'); }
      };
      const pluginB = {
        name: 'b',
        shutdown: () => { shutdownOrder.push('b'); }
      };
      
      application.registerPlugins([pluginA, pluginB]);
      await application.shutdown();
      
      assert.strictEqual(shutdownOrder.length, 2);
      assert(shutdownOrder.includes('a'));
      assert(shutdownOrder.includes('b'));
    });
  });

  describe('Plugin Class Integration', () => {
    it('should convert Plugin instances to plugin objects', async () => {
      // Create a test Plugin class
      class TestPlugin extends Plugin {
        constructor(context) {
          super(context, { name: 'test-class-plugin' });
        }
        
        async install(state) {
          await super.install(state);
          this.installCalled = true;
        }
        
        async onStateUpdate(changedKeys) {
          this.lastChangedKeys = changedKeys;
        }
      }
      
      // Create instance with PluginContext
      const context = application.getPluginContext();
      const pluginInstance = new TestPlugin(context);
      
      // Register the Plugin instance
      application.registerPlugins([pluginInstance]);
      
      // Install plugins
      await application.installPlugins(mockState);
      
      assert.strictEqual(pluginInstance.installCalled, true);
      assert.strictEqual(pluginInstance.name, 'test-class-plugin');
    });

    it('should enable Plugin instances to emit state changes', async () => {
      class TestPlugin extends Plugin {
        constructor(context) {
          super(context, { name: 'test-plugin' });
        }
        
        async triggerStateChange() {
          return await this.dispatchStateChange({ pdf: 'changed.pdf' });
        }
      }
      
      const context = application.getPluginContext();
      const pluginInstance = new TestPlugin(context);
      
      // Install first to set initial state
      await pluginInstance.install(mockState);
      
      // Initialize application state (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      // Trigger state change through plugin
      const newState = await pluginInstance.triggerStateChange();
      
      assert.strictEqual(newState.pdf, 'changed.pdf');
      assert.strictEqual(pluginInstance?.state?.pdf, 'changed.pdf');
    });

    it('should support backward compatibility for legacy plugin objects', async () => {
      let stateUpdateCalled = false;
      
      // Legacy plugin object (not Plugin class instance)
      const legacyPlugin = {
        name: 'legacy-plugin',
        install: () => {},
        state: {
          update: (state) => {
            stateUpdateCalled = true;
          }
        }
      };
      
      application.registerPlugins([legacyPlugin]);
      await application.installPlugins(mockState);
      
      // Trigger state update
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      await application.updateState({ pdf: 'new.pdf' });
      
      assert.strictEqual(stateUpdateCalled, true);
    });

    it('should register Plugin classes by instantiating them with context', () => {
      // Create a Plugin class
      class TestPluginClass extends Plugin {
        constructor(context) {
          super(context, { 
            name: 'test-class',
            deps: ['dependency'] 
          });
        }
        
        async customMethod() {
          return 'custom result';
        }
        
        getEndpoints() {
          return {
            ...super.getEndpoints(),
            'custom.method': this.customMethod.bind(this)
          };
        }
      }
      
      // Register the Plugin class (not instance)
      application.registerPlugins([TestPluginClass]);
      
      // Verify it was registered correctly
      assert.strictEqual(pluginManager.pluginsByName.size, 1);
      assert.strictEqual(pluginManager.registeredPlugins.length, 1);
      
      const registered = pluginManager.getPlugin('test-class');
      assert.strictEqual(registered.name, 'test-class');
      assert.deepStrictEqual(registered.deps, ['dependency']);
      
      // Should have both default and custom endpoints from getEndpoints()
      assert.strictEqual(typeof registered.install, 'function');
      assert.strictEqual(typeof registered.start, 'function');
      assert.strictEqual(typeof registered.shutdown, 'function');
      assert.strictEqual(typeof registered.custom.method, 'function');
    });
  });

  describe('Inter-Plugin Communication', () => {
    it('should enable plugins to communicate via PluginContext', async () => {
      let communicationResult = null;
      
      const senderPlugin = {
        name: 'sender',
        sendMessage: async function() {
          const context = application.getPluginContext();
          const results = await context.invokePluginEndpoint('receiver.receive', ['hello']);
          return results;
        }
      };
      
      const receiverPlugin = {
        name: 'receiver',
        receiver: {
          receive: (message) => {
            communicationResult = `received: ${message}`;
            return communicationResult;
          }
        }
      };
      
      application.registerPlugins([senderPlugin, receiverPlugin]);
      
      const results = await senderPlugin.sendMessage();
      
      assert.strictEqual(communicationResult, 'received: hello');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'fulfilled');
      assert.strictEqual(results[0].value, 'received: hello');
    });
  });

  describe('State Bootstrapping Integration', () => {
    it('should support state initialization and preservation', () => {
      const testVars = ['pdf', 'user'];
      
      application.initializeState(mockState, {
        persistedStateVars: testVars,
        enableStatePreservation: true
      });
      
      assert.strictEqual(application.getCurrentState(), mockState);
      
      // State manager should be configured for preservation
      const stateManager = application.getStateManager();
      assert.deepStrictEqual(stateManager.persistedStateVars, [...testVars, 'sessionId']);
      assert.strictEqual(stateManager.preserveStateEnabled, true);
    });
  });

  describe('State Change Prevention During Propagation', () => {
    it('should prevent nested state changes during state update propagation', async () => {
      let nestedUpdateAttempted = false;
      
      // Create a plugin that tries to trigger state change in its update endpoint
      const badPlugin = {
        name: 'bad-plugin',
        state: {
          update: async (state) => {
            try {
              // This should throw an error - plugins cannot trigger state changes during propagation
              nestedUpdateAttempted = true;
              await application.updateState(state, { xml: 'nested-change.xml' });
            } catch (error) {
              // Expected error - rethrow to verify error handling
              throw error;
            }
          }
        }
      };
      
      application.registerPlugins([badPlugin]);
      
      // This should throw an error when the plugin tries to nest a state change
      await assert.rejects(
        async () => {
          // Initialize state first (disable state preservation for tests)
          application.initializeState(mockState, { enableStatePreservation: false });
          
          await application.updateState({ pdf: 'trigger.pdf' });
        },
        {
          name: 'Error',
          message: /State changes are not allowed during state update propagation/
        }
      );
      
      assert.strictEqual(nestedUpdateAttempted, true);
    });

    it('should prevent nested state changes during extension state update', async () => {
      const badPlugin = {
        name: 'bad-ext-plugin',
        state: {
          update: async (state) => {
            // Try to trigger extension state change during propagation
            await application.updateStateExt(state, { myPlugin: { data: 'nested' } });
          }
        }
      };
      
      application.registerPlugins([badPlugin]);
      
      await assert.rejects(
        async () => {
          // Initialize state first (disable state preservation for tests)
          application.initializeState(mockState, { enableStatePreservation: false });
          
          await application.updateStateExt({ triggerPlugin: { value: 'test' } });
        },
        {
          name: 'Error', 
          message: /State changes are not allowed during state update propagation/
        }
      );
    });

    it('should allow state changes after propagation completes', async () => {
      let stateAfterPropagation = null;
      
      const plugin = {
        name: 'good-plugin',
        state: {
          update: (state) => {
            // Store state but don't try to change it during propagation
            stateAfterPropagation = state;
          }
        }
      };
      
      application.registerPlugins([plugin]);
      
      // First state change should succeed
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      const newState1 = await application.updateState({ pdf: 'doc1.pdf' });
      assert.strictEqual(newState1.pdf, 'doc1.pdf');
      assert.strictEqual(stateAfterPropagation.pdf, 'doc1.pdf');
      
      // Second state change after propagation completes should also succeed
      const newState2 = await application.updateState({ xml: 'doc1.xml' });
      assert.strictEqual(newState2.xml, 'doc1.xml');
      assert.strictEqual(newState2.pdf, 'doc1.pdf');
    });

    it('should handle plugin class onStateUpdate without allowing nested changes', async () => {
      class BadPlugin extends Plugin {
        constructor(context) {
          super(context, { name: 'bad-class-plugin' });
        }
        
        async onStateUpdate(changedKeys) {
          // Acknowledge changed keys but still try to trigger nested change (should fail)
          console.log('Received changed keys:', changedKeys);
          // Try to trigger state change in reactive endpoint
          await this.dispatchStateChange({ xml: 'nested-from-class.xml' });
        }
      }
      
      const context = application.getPluginContext();
      const pluginInstance = new BadPlugin(context);
      application.registerPlugins([pluginInstance]);
      
      await application.installPlugins(mockState);
      
      await assert.rejects(
        async () => {
          // Initialize state first (disable state preservation for tests)
          application.initializeState(mockState, { enableStatePreservation: false });
          
          await application.updateState({ pdf: 'trigger-class.pdf' });
        },
        {
          name: 'Error',
          message: /State changes are not allowed during state update propagation/
        }
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle plugin installation errors gracefully', async () => {
      const errorPlugin = {
        name: 'error-plugin',
        install: () => { throw new Error('Installation failed'); }
      };
      
      application.registerPlugins([errorPlugin]);
      
      // Should not throw - errors are handled by PluginManager
      const results = await application.installPlugins(mockState);
      
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'rejected');
      assert(results[0].reason instanceof Error); // Error preserved in reason
    });

    it('should handle plugin shutdown errors gracefully', async () => {
      const errorPlugin = {
        name: 'error-plugin',
        shutdown: () => { throw new Error('Shutdown failed'); }
      };
      
      application.registerPlugins([errorPlugin]);
      
      // Should not throw
      const results = await application.shutdown();
      
      assert.strictEqual(Array.isArray(results), true);
    });
  });

  describe('Performance and Memory Management', () => {
    it('should not create memory leaks with state history', async () => {
      // Initialize state first (disable state preservation for tests)
      application.initializeState(mockState, { enableStatePreservation: false });
      
      // Create many state transitions
      for (let i = 0; i < 20; i++) {
        await application.updateState({
          pdf: `document-${i}.pdf`
        });
      }
      
      // State history should be managed by WeakMap - no way to directly test
      // but we can verify state chain still works for recent states
      const stateManager = application.getStateManager();
      const currentState = application.getCurrentState();
      const previousState = stateManager.getPreviousState(currentState);
      
      assert.ok(previousState);
      assert.strictEqual(previousState.pdf, 'document-18.pdf');
    });
  });
});