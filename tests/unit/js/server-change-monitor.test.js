#!/usr/bin/env node

/**
 * @testCovers app/src/modules/server-change-monitor.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ServerChangeMonitor, NOTICE_KEY, RESTORE_MESSAGE, PLUGINS_MESSAGE, changeMessage
} from '../../../app/src/modules/server-change-monitor.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}

function setup(statuses, storage = memoryStorage()) {
  const queue = [...statuses];
  const calls = { reloads: 0, fetches: 0 };
  const monitor = new ServerChangeMonitor({
    fetchStatus: async () => {
      calls.fetches++;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    reload: () => { calls.reloads++; },
    storage,
    logger: { debug() {}, info() {} }
  });
  return { monitor, calls, storage };
}

const base = { data_restore: null, plugins_version: 3 };

describe('changeMessage', () => {
  it('detects a restore', () => {
    assert.strictEqual(changeMessage(base, { ...base, data_restore: { id: 'x', applied_at: '' } }), RESTORE_MESSAGE);
  });
  it('detects a plugin change', () => {
    assert.strictEqual(changeMessage(base, { ...base, plugins_version: 4 }), PLUGINS_MESSAGE);
  });
  it('ignores a pending restart and unchanged state', () => {
    assert.strictEqual(changeMessage(base, { ...base, plugins_version: null }), null);
    assert.strictEqual(changeMessage(base, { ...base }), null);
  });
});

describe('ServerChangeMonitor', () => {
  it('does not reload while nothing changes', async () => {
    const { monitor, calls } = setup([base]);
    assert.strictEqual(await monitor.init(), null);
    await monitor.check();
    assert.strictEqual(calls.reloads, 0);
  });

  it('reloads after a restore and leaves the message for the next page', async () => {
    const { monitor, calls, storage } = setup([base, { ...base, data_restore: { id: '20261022_101010', applied_at: '' } }]);
    await monitor.init();
    await monitor.check();
    assert.strictEqual(calls.reloads, 1);
    assert.strictEqual(storage.data[NOTICE_KEY], RESTORE_MESSAGE);
    await monitor.check();
    assert.strictEqual(calls.reloads, 1);
  });

  it('waits for the restart before reloading for plugin changes', async () => {
    const { monitor, calls } = setup([base, { ...base, plugins_version: null }, { ...base, plugins_version: 4 }]);
    await monitor.init();
    await monitor.check();
    assert.strictEqual(calls.reloads, 0);
    await monitor.check();
    assert.strictEqual(calls.reloads, 1);
  });

  it('returns and clears the message left before the reload', async () => {
    const storage = memoryStorage({ [NOTICE_KEY]: PLUGINS_MESSAGE });
    const { monitor } = setup([base], storage);
    assert.strictEqual(await monitor.init(), PLUGINS_MESSAGE);
    assert.strictEqual(storage.data[NOTICE_KEY], undefined);
  });

  it('ignores an unreachable server and works without storage', async () => {
    const { monitor, calls } = setup([new Error('offline'), base, { ...base, plugins_version: 5 }], null);
    assert.strictEqual(await monitor.init(), null);
    await monitor.check();
    await monitor.check();
    assert.strictEqual(calls.reloads, 1);
  });

  it('postpones the reload while held', async () => {
    const { monitor, calls, storage } = setup([base, { ...base, plugins_version: 4 }]);
    await monitor.init();
    await monitor.hold(true);
    await monitor.check();
    await monitor.check();
    assert.strictEqual(calls.reloads, 0);
    await monitor.hold(false);
    assert.strictEqual(calls.reloads, 1);
    assert.strictEqual(storage.data[NOTICE_KEY], PLUGINS_MESSAGE);
  });

  it('shares one request between concurrent checks', async () => {
    const { monitor, calls } = setup([base]);
    await Promise.all([monitor.check(), monitor.check(), monitor.check()]);
    assert.strictEqual(calls.fetches, 1);
  });
});
