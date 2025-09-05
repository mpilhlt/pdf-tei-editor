/**
 * Unit tests for PluginManager
 * Tests dependency resolution, topological sorting, circular dependency detection,
 * endpoint invocation, timeout handling, and all other plugin manager behaviors.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import PluginManager from '../app/src/modules/plugin-manager.js';
import Plugin from '../app/src/modules/plugin-base.js';
import StateManager from '../app/src/modules/state-manager.js';
import { Application } from '../app/src/modules/application.js';

// Mock window for shutdown handler
// @ts-ignore
global.window = {
  addEventListener: () => {}
};

describe('PluginManager', () => {
  let pluginManager;
  
  beforeEach(() => {
    pluginManager = new PluginManager();
  });

  describe('Constructor', () => {
    it('should create plugin manager with default timeout', () => {
      const pm = new PluginManager();
      assert.strictEqual(pm.config.timeout, 2000);
      assert.strictEqual(pm.config.throws, false);
    });

    it('should accept custom timeout, throws, and debug options', () => {
      const pm = new PluginManager({ timeout: 5000, throws: true, debug: true });
      assert.strictEqual(pm.config.timeout, 5000);
      assert.strictEqual(pm.config.throws, true);
      assert.strictEqual(pm.debug, true);
    });
  });

  describe('Plugin Registration', () => {
    it('should register a simple plugin', () => {
      const plugin = { name: 'test' };
      pluginManager.register(plugin);
      
      assert.strictEqual(pluginManager.pluginsByName.size, 1);
      assert.strictEqual(pluginManager.registeredPlugins.length, 1);
      
      const registered = pluginManager.getPlugin('test');
      assert.strictEqual(registered.name, 'test');
      assert(Array.isArray(registered.deps));
    });

    it('should throw error for invalid plugin object', () => {
      assert.throws(() => {
        pluginManager.register(null);
      }, /Plugin must be an object/);
    });

    it('should throw error for plugin without name', () => {
      assert.throws(() => {
        pluginManager.register({});
      }, /Every plugin must have a name property/);
    });

    it('should throw error for duplicate plugin names', () => {
      pluginManager.register({ name: 'test' });
      assert.throws(() => {
        pluginManager.register({ name: 'test' });
      }, /Plugin "test" is already registered/);
    });

    it('should normalize dependencies to array', () => {
      const plugin = { name: 'test' };
      pluginManager.register(plugin);
      
      const registered = pluginManager.getPlugin('test');
      assert(Array.isArray(registered.deps));
      assert.strictEqual(registered.deps.length, 0);
    });

    it('should call Plugin initialize method if Plugin instance is registered', () => {
      let initializeCalled = false;
      
      // Create a proper PluginContext using Application
      const stateManager = new StateManager();
      const application = new Application(pluginManager, stateManager);
      const pluginContext = application.getPluginContext();
      
      // Create a Plugin instance with overridden initialize method
      class TestPlugin extends Plugin {
        async initialize() {
          initializeCalled = true;
        }
      }
      
      const pluginInstance = new TestPlugin(pluginContext, { name: 'test' });
      pluginManager.register(pluginInstance);
      
      assert.strictEqual(initializeCalled, true);
    });

    it('should register Plugin class instances by converting them to plugin objects', () => {
      // Create a proper PluginContext using Application
      const stateManager = new StateManager();
      const application = new Application(pluginManager, stateManager);
      const pluginContext = application.getPluginContext();
      
      // Create a Plugin instance
      const pluginInstance = new Plugin(pluginContext, { 
        name: 'test-class-plugin',
        deps: ['dependency'] 
      });
      
      // Register the Plugin instance
      pluginManager.register(pluginInstance);
      
      // Verify it was registered correctly
      assert.strictEqual(pluginManager.pluginsByName.size, 1);
      assert.strictEqual(pluginManager.registeredPlugins.length, 1);
      
      const registered = pluginManager.getPlugin('test-class-plugin');
      assert.strictEqual(registered.name, 'test-class-plugin');
      assert.deepStrictEqual(registered.deps, ['dependency']);
      
      // Should have the basic lifecycle endpoints from getEndpoints()
      assert.strictEqual(typeof registered.install, 'function');
      assert.strictEqual(typeof registered.start, 'function');
      assert.strictEqual(typeof registered.shutdown, 'function');
      // Note: state.update is not included by default in base Plugin class
    });

    it('should register Plugin instances with custom endpoint mappings', () => {
      // Create a proper PluginContext using Application
      const stateManager = new StateManager();
      const application = new Application(pluginManager, stateManager);
      const pluginContext = application.getPluginContext();
      
      // Create a Plugin instance with custom endpoints
      class CustomPlugin extends Plugin {
        async validate(options) {
          return { valid: true };
        }
        
        async handleStateUpdate(state) {
          return state;
        }
        
        getEndpoints() {
          return {
            ...super.getEndpoints(),
            'validation.validate': this.validate.bind(this),
            'state.update': this.handleStateUpdate.bind(this)
          };
        }
      }
      
      const pluginInstance = new CustomPlugin(pluginContext, { 
        name: 'custom-plugin',
        deps: [] 
      });
      
      // Register the Plugin instance
      pluginManager.register(pluginInstance);
      
      const registered = pluginManager.getPlugin('custom-plugin');
      
      // Should have both default and custom endpoints
      assert.strictEqual(typeof registered.install, 'function');
      assert.strictEqual(typeof registered.start, 'function');
      assert.strictEqual(typeof registered.shutdown, 'function');
      assert.strictEqual(typeof registered.validation.validate, 'function');
      assert.strictEqual(typeof registered.state.update, 'function');
    });
  });

  describe('Plugin Unregistration', () => {
    it('should unregister existing plugin', () => {
      pluginManager.register({ name: 'test' });
      pluginManager.unregister('test');
      
      assert.strictEqual(pluginManager.pluginsByName.size, 0);
      assert.strictEqual(pluginManager.registeredPlugins.length, 0);
      assert.strictEqual(pluginManager.getPlugin('test'), undefined);
    });

    it('should throw error when unregistering non-existent plugin', () => {
      assert.throws(() => {
        pluginManager.unregister('nonexistent');
      }, /Plugin "nonexistent" doesn't exist/);
    });
  });

  describe('Dependency Resolution', () => {
    it('should resolve simple dependency chain', () => {
      pluginManager.register({ name: 'a', deps: ['b'] });
      pluginManager.register({ name: 'b', deps: ['c'] });
      pluginManager.register({ name: 'c' });
      
      const ordered = pluginManager.dependencyOrderedPlugins;
      const names = ordered.map(p => p.name);
      
      assert.deepStrictEqual(names, ['c', 'b', 'a']);
    });

    it('should resolve complex dependency graph', () => {
      pluginManager.register({ name: 'a', deps: ['b', 'c'] });
      pluginManager.register({ name: 'b', deps: ['d'] });
      pluginManager.register({ name: 'c', deps: ['d'] });
      pluginManager.register({ name: 'd' });
      
      const ordered = pluginManager.dependencyOrderedPlugins;
      const names = ordered.map(p => p.name);
      
      // d should come first, then b and c (in either order), then a
      assert.strictEqual(names[0], 'd');
      assert.strictEqual(names[3], 'a');
      assert(names.includes('b') && names.includes('c'));
    });

    it('should handle missing dependencies gracefully', () => {
      pluginManager.register({ name: 'a', deps: ['missing'] });
      
      const plugins = pluginManager.getPlugins('.');
      assert.strictEqual(plugins.length, 0); // Plugin filtered out due to missing dependency
    });

    it('should detect circular dependencies', () => {
      pluginManager.register({ name: 'a', deps: ['b'] });
      
      assert.throws(() => {
        pluginManager.register({ name: 'b', deps: ['a'] });
      }, /Circular dependency detected: a → b/);
    });

    it('should detect complex circular dependencies', () => {
      pluginManager.register({ name: 'a', deps: ['b'] });
      pluginManager.register({ name: 'b', deps: ['c'] });
      
      assert.throws(() => {
        pluginManager.register({ name: 'c', deps: ['a'] });
      }, /Circular dependency detected: a → b → c/);
    });
  });

  describe('Endpoint Detection', () => {
    it('should detect function endpoints', () => {
      const plugin = {
        name: 'test',
        install: () => {},
        state: {
          update: () => {}
        }
      };
      
      assert.strictEqual(pluginManager.hasEndpoint(plugin, 'install'), true);
      assert.strictEqual(pluginManager.hasEndpoint(plugin, 'state.update'), true);
      assert.strictEqual(pluginManager.hasEndpoint(plugin, 'missing'), false);
      assert.strictEqual(pluginManager.hasEndpoint(plugin, 'state.missing'), false);
    });

    it('should get endpoint values', () => {
      const installFn = () => {};
      const updateFn = () => {};
      const plugin = {
        name: 'test',
        install: installFn,
        state: {
          update: updateFn
        }
      };
      
      assert.strictEqual(pluginManager.getEndpointValue(plugin, 'install'), installFn);
      assert.strictEqual(pluginManager.getEndpointValue(plugin, 'state.update'), updateFn);
      assert.strictEqual(pluginManager.getEndpointValue(plugin, 'missing'), undefined);
    });
  });

  describe('Plugin Filtering', () => {
    beforeEach(() => {
      pluginManager.register({
        name: 'a',
        install: () => {},
        start: () => {}
      });
      pluginManager.register({
        name: 'b',
        install: () => {},
        state: { update: () => {} }
      });
      pluginManager.register({
        name: 'c',
        start: () => {}
      });
    });

    it('should get all plugins with "." endpoint', () => {
      const plugins = pluginManager.getPlugins('.');
      assert.strictEqual(plugins.length, 3);
      assert.deepStrictEqual(plugins.map(p => p.name), ['a', 'b', 'c']);
    });

    it('should filter plugins by endpoint', () => {
      const installPlugins = pluginManager.getPlugins('install');
      assert.strictEqual(installPlugins.length, 2);
      assert.deepStrictEqual(installPlugins.map(p => p.name), ['a', 'b']);

      const startPlugins = pluginManager.getPlugins('start');
      assert.strictEqual(startPlugins.length, 2);
      assert.deepStrictEqual(startPlugins.map(p => p.name), ['a', 'c']);

      const stateUpdatePlugins = pluginManager.getPlugins('state.update');
      assert.strictEqual(stateUpdatePlugins.length, 1);
      assert.deepStrictEqual(stateUpdatePlugins.map(p => p.name), ['b']);
    });

    it('should cache filtered results', () => {
      const plugins1 = pluginManager.getPlugins('install');
      const plugins2 = pluginManager.getPlugins('install');
      
      assert.strictEqual(plugins1, plugins2); // Same reference due to caching
    });

    it('should clear cache when plugins are registered/unregistered', () => {
      const plugins1 = pluginManager.getPlugins('install');
      
      pluginManager.register({ name: 'd', install: () => {} });
      const plugins2 = pluginManager.getPlugins('install');
      
      assert.notStrictEqual(plugins1, plugins2); // Cache was cleared
      assert.strictEqual(plugins2.length, 3);
    });
  });

  describe('Plugin Invocation', async () => {
    it('should invoke endpoints in dependency order', async () => {
      const callOrder = [];
      
      pluginManager.register({
        name: 'a',
        deps: ['b'],
        start: () => { callOrder.push('a'); return 'result-a'; }
      });
      pluginManager.register({
        name: 'b',
        deps: ['c'],
        start: () => { callOrder.push('b'); return 'result-b'; }
      });
      pluginManager.register({
        name: 'c',
        start: () => { callOrder.push('c'); return 'result-c'; }
      });
      
      const results = await pluginManager.invoke('start');
      
      assert.deepStrictEqual(callOrder, ['c', 'b', 'a']);
      assert.strictEqual(results.length, 3);
      assert.strictEqual(results[0].status, 'fulfilled');
      assert.strictEqual(results[0].value, 'result-c');
    });

    it('should pass arguments to endpoint functions', async () => {
      let receivedArgs;
      
      pluginManager.register({
        name: 'test',
        install: (...args) => { receivedArgs = args; return 'ok'; }
      });
      
      await pluginManager.invoke('install', ['arg1', { prop: 'value' }, 42]);
      
      assert.deepStrictEqual(receivedArgs, ['arg1', { prop: 'value' }, 42]);
    });

    it('should handle multiple parameters via array spreading', async () => {
      let receivedArgs;
      
      pluginManager.register({
        name: 'test',
        multiParam: (param1, param2, param3) => { 
          receivedArgs = { param1, param2, param3 }; 
          return receivedArgs; 
        }
      });
      
      await pluginManager.invoke('multiParam', ['hello', 'world', 123]);
      
      assert.deepStrictEqual(receivedArgs, { 
        param1: 'hello', 
        param2: 'world', 
        param3: 123 
      });
    });

    it('should handle single non-array parameter', async () => {
      let receivedArgs;
      
      pluginManager.register({
        name: 'test',
        singleParam: (param) => { 
          receivedArgs = param; 
          return param; 
        }
      });
      
      await pluginManager.invoke('singleParam', 'single-string');
      
      assert.strictEqual(receivedArgs, 'single-string');
    });

    it('should handle array parameter by wrapping in another array', async () => {
      let receivedArgs;
      
      pluginManager.register({
        name: 'test',
        arrayParam: (arrayParam) => { 
          receivedArgs = arrayParam; 
          return arrayParam; 
        }
      });
      
      // To pass an array as single parameter, wrap it in another array
      await pluginManager.invoke('arrayParam', [['item1', 'item2', 'item3']]);
      
      assert.deepStrictEqual(receivedArgs, ['item1', 'item2', 'item3']);
    });

    it('should support sequential execution mode', async () => {
      const callOrder = [];
      
      pluginManager.register({
        name: 'a',
        deps: ['b'],
        test: async () => { 
          await new Promise(resolve => setTimeout(resolve, 10));
          callOrder.push('a'); 
          return 'result-a'; 
        }
      });
      pluginManager.register({
        name: 'b',
        deps: ['c'],
        test: async () => { 
          await new Promise(resolve => setTimeout(resolve, 10));
          callOrder.push('b'); 
          return 'result-b'; 
        }
      });
      pluginManager.register({
        name: 'c',
        test: async () => { 
          await new Promise(resolve => setTimeout(resolve, 10));
          callOrder.push('c'); 
          return 'result-c'; 
        }
      });
      
      await pluginManager.invoke('test', [], { mode: 'sequential' });
      
      // Should execute in dependency order: c -> b -> a
      assert.deepStrictEqual(callOrder, ['c', 'b', 'a']);
    });

    it('should support parallel execution mode (default)', async () => {
      const callOrder = [];
      let resolveA, resolveB, resolveC;
      
      pluginManager.register({
        name: 'a',
        deps: ['b'],
        test: () => new Promise(resolve => { resolveA = resolve; })
      });
      pluginManager.register({
        name: 'b', 
        deps: ['c'],
        test: () => new Promise(resolve => { resolveB = resolve; })
      });
      pluginManager.register({
        name: 'c',
        test: () => new Promise(resolve => { resolveC = resolve; })
      });
      
      // Start parallel execution
      const resultPromise = pluginManager.invoke('test', [], { mode: 'parallel' });
      
      // Resolve in reverse order to test parallelism
      setTimeout(() => { resolveA(); callOrder.push('a'); }, 10);
      setTimeout(() => { resolveB(); callOrder.push('b'); }, 5);  
      setTimeout(() => { resolveC(); callOrder.push('c'); }, 1);
      
      await resultPromise;
      
      // In parallel mode, execution order depends on timing, not dependencies
      // We just verify all executed
      assert.strictEqual(callOrder.length, 3);
      assert(callOrder.includes('a'));
      assert(callOrder.includes('b'));
      assert(callOrder.includes('c'));
    });

    it('should handle timeout options', async () => {
      pluginManager.register({
        name: 'test',
        slow: () => new Promise(resolve => setTimeout(() => resolve('done'), 100))
      });
      
      const results = await pluginManager.invoke('slow', [], { timeout: 50 });
      
      // Should still return result array even if individual promises timeout
      assert.strictEqual(results.length, 1);
    });

    it('should use proper method context for nested endpoints', async () => {
      let actualContext;
      
      const stateObj = {
        update: function() { actualContext = this; return 'updated'; }
      };
      
      pluginManager.register({
        name: 'test',
        state: stateObj
      });
      
      await pluginManager.invoke('state.update');
      
      assert.strictEqual(actualContext, stateObj);
    });

    it('should handle non-function endpoints with !prefix', async () => {
      pluginManager.register({
        name: 'test',
        config: { value: 'test-config' }
      });
      
      const results = await pluginManager.invoke('!config.value');
      
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'fulfilled');
      assert.strictEqual(results[0].value, 'test-config');
    });

    it('should handle errors gracefully', async () => {
      pluginManager.register({
        name: 'test',
        failing: () => { throw new Error('Test error'); }
      });
      
      const results = await pluginManager.invoke('failing');
      
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'fulfilled');
      assert.strictEqual(results[0].value, null); // Error handled, returns null
    });

    it('should throw errors when configured with throws flag', async () => {
      const pm = new PluginManager({ throws: true });
      pm.register({
        name: 'test',
        failing: () => { throw new Error('Test error'); }
      });
      
      const results = await pm.invoke('failing');
      
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'rejected');
      assert(results[0].reason instanceof Error);
    });

    it('should throw errors with !suffix flag', async () => {
      pluginManager.register({
        name: 'test',
        failing: () => { throw new Error('Test error'); }
      });
      
      const results = await pluginManager.invoke('failing!');
      
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'rejected');
      assert(results[0].reason instanceof Error);
    });
  });

  describe('Utility Methods', () => {
    it('should sort arrays by property', () => {
      const items = [
        { name: 'c', order: 3 },
        { name: 'a', order: 1 },
        { name: 'b', order: 2 }
      ];
      
      pluginManager.sort(items);
      
      assert.deepStrictEqual(items.map(i => i.name), ['a', 'b', 'c']);
    });

    it('should use default order for items without order property', () => {
      const items = [
        { name: 'a', order: 1 },
        { name: 'b' }, // No order property
        { name: 'c', order: 2 }
      ];
      
      pluginManager.sort(items);
      
      assert.deepStrictEqual(items.map(i => i.name), ['a', 'c', 'b']);
    });

    it('should process raw plugins with callback', () => {
      pluginManager.register({ name: 'a' });
      pluginManager.register({ name: 'b' });
      
      let processedPlugins;
      pluginManager.processRawPlugins(plugins => {
        processedPlugins = [...plugins];
        plugins.push({ name: 'c' });
      });
      
      assert.strictEqual(processedPlugins.length, 2);
      assert.strictEqual(pluginManager.registeredPlugins.length, 3);
    });
  });

  describe('Debug Mode', () => {
    it('should default debug to false', () => {
      const pm = new PluginManager();
      assert.strictEqual(pm.debug, false);
    });

    it('should accept debug option in constructor', () => {
      const pm = new PluginManager({ debug: true });
      assert.strictEqual(pm.debug, true);
    });

    it('should allow toggling debug mode', () => {
      const pm = new PluginManager();
      assert.strictEqual(pm.debug, false);
      
      pm.debug = true;
      assert.strictEqual(pm.debug, true);
      
      pm.debug = false;
      assert.strictEqual(pm.debug, false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty plugin registration', () => {
      assert.strictEqual(pluginManager.dependencyOrderedPlugins.length, 0);
      assert.strictEqual(pluginManager.getPlugins('.').length, 0);
    });

    it('should handle invoke with no matching plugins', async () => {
      const results = await pluginManager.invoke('nonexistent');
      assert.strictEqual(results.length, 0);
    });

    it('should handle deeply nested endpoint paths', () => {
      const plugin = {
        name: 'test',
        deep: {
          nested: {
            method: () => 'deep result'
          }
        }
      };
      
      pluginManager.register(plugin);
      
      assert.strictEqual(
        pluginManager.hasEndpoint(plugin, 'deep.nested.method'),
        true
      );
      assert.strictEqual(
        pluginManager.getEndpointValue(plugin, 'deep.nested.method')(),
        'deep result'
      );
    });

    it('should handle plugins with no dependencies', () => {
      pluginManager.register({ name: 'independent' });
      
      const ordered = pluginManager.dependencyOrderedPlugins;
      assert.strictEqual(ordered.length, 1);
      assert.strictEqual(ordered[0].name, 'independent');
    });
  });
});