// Side panel / options switch for one session grant. Ported from the
// Amazon-only switch; the storage is now one map of grant id → on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountGrantSettings } from '../extension/handoff/settings.js';
import { GRANTS_KEY } from '../extension/handoff/grants.js';

const GRANT = 'amazon-sc';
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function eventSource() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    fire(...args) { for (const listener of [...listeners]) listener(...args); },
    get listenerCount() { return listeners.size; },
  };
}

function sharedLockManager() {
  const tails = new Map();
  const requests = [];
  return {
    requests,
    request(name, callback) {
      requests.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      tails.set(name, previous.then(() => held));
      return previous.then(async () => {
        try { return await callback({ name }); }
        finally { release(); }
      });
    },
  };
}

function element() {
  return {
    disabled: false,
    checked: false,
    textContent: '',
    handlers: new Map(),
    addEventListener(type, handler) { this.handlers.set(type, handler); },
    removeEventListener(type, handler) {
      if (this.handlers.get(type) === handler) this.handlers.delete(type);
    },
    fire(type, event = {}) {
      return this.handlers.get(type)?.({ target: this, ...event });
    },
  };
}

function harness({
  enabled = false,
  granted = false,
  ui = 'buttons',
  requestResult = true,
  requestError,
  requestGate,
  removeError,
  removeGate,
  lockManager,
  extraGrants = {},
} = {}) {
  const events = [];
  const state = { [GRANTS_KEY]: { ...extraGrants, [GRANT]: enabled } };
  const messageKeys = [];
  const chromeApi = {
    storage: {
      local: {
        async get(key) {
          events.push(['get', key]);
          return { [GRANTS_KEY]: { ...state[GRANTS_KEY] } };
        },
        async set(update) {
          events.push(['set', update[GRANTS_KEY]?.[GRANT]]);
          Object.assign(state, update);
        },
      },
      onChanged: eventSource(),
    },
    permissions: {
      onAdded: eventSource(),
      onRemoved: eventSource(),
      async contains(details) {
        events.push(['contains', details]);
        return granted;
      },
      request(details) {
        events.push(['request', details]);
        if (requestError) return Promise.reject(requestError);
        const result = requestGate ? requestGate.promise : Promise.resolve(requestResult);
        return result.then((approved) => {
          if (approved) granted = true;
          return approved;
        });
      },
      remove(details) {
        events.push(['remove', details]);
        if (removeError) return Promise.reject(removeError);
        const result = removeGate ? removeGate.promise : Promise.resolve(true);
        return result.then((removed) => {
          if (removed) granted = false;
          return removed;
        });
      },
    },
  };
  const elements = {
    toggle: ui === 'toggle' ? element() : undefined,
    enable: ui === 'buttons' ? element() : undefined,
    disable: ui === 'buttons' ? element() : undefined,
    status: element(),
  };
  const controller = mountGrantSettings({
    grantId: GRANT,
    chromeApi,
    lockManager,
    ...elements,
    message(key) {
      messageKeys.push(key);
      return `message:${key}`;
    },
  });

  return {
    controller,
    chromeApi,
    elements,
    events,
    messageKeys,
    state,
    get granted() { return granted; },
    set granted(value) { granted = value; },
  };
}

async function initialize(h) {
  await flush();
  return h;
}

function mutationEvents(h) {
  return h.events.filter(([type]) => ['request', 'set', 'remove'].includes(type));
}

test('initialization shows active only when opt-in and cookie permission are both present', async () => {
  const cases = [
    { enabled: false, granted: false, active: false },
    { enabled: true, granted: false, active: false },
    { enabled: false, granted: true, active: false },
    { enabled: true, granted: true, active: true },
  ];

  for (const state of cases) {
    const h = await initialize(harness({ ...state, ui: 'buttons' }));
    assert.equal(h.elements.status.textContent, `message:${state.active ? 'active' : 'inactive'}`);
    assert.equal(h.elements.enable.disabled, state.active);
    assert.equal(h.elements.disable.disabled, !state.enabled && !state.granted);
    assert.deepEqual(mutationEvents(h), []);
    assert.equal(h.events.filter(([type]) => type === 'contains').length, 1);
  }

  const toggle = await initialize(harness({ enabled: true, granted: false, ui: 'toggle' }));
  assert.equal(toggle.elements.toggle.checked, false);
  assert.equal(toggle.elements.status.textContent, 'message:inactive');
  assert.deepEqual(mutationEvents(toggle), []);
});

test('button enable requests permission synchronously before saving opt-in', async () => {
  const requestGate = deferred();
  const h = await initialize(harness({ ui: 'buttons', requestGate }));

  const activation = h.elements.enable.fire('click');
  assert.deepEqual(mutationEvents(h).map(([type]) => type), ['request']);
  assert.equal(h.state[GRANTS_KEY][GRANT], false);
  assert.equal(h.elements.enable.disabled, true);

  requestGate.resolve(true);
  await activation;
  await flush();
  assert.deepEqual(mutationEvents(h).map(([type, value]) => [type, type === 'set' ? value : undefined]), [
    ['request', undefined], ['set', true],
  ]);
  assert.equal(h.state[GRANTS_KEY][GRANT], true);
  assert.equal(h.elements.status.textContent, 'message:active');
});

test('checkbox enable requests permission in the change gesture before saving opt-in', async () => {
  const requestGate = deferred();
  const h = await initialize(harness({ ui: 'toggle', requestGate }));

  h.elements.toggle.checked = true;
  const activation = h.elements.toggle.fire('change');
  assert.deepEqual(mutationEvents(h).map(([type]) => type), ['request']);
  assert.equal(h.state[GRANTS_KEY][GRANT], false);
  assert.equal(h.elements.toggle.disabled, true);

  requestGate.resolve(true);
  await activation;
  await flush();
  assert.deepEqual(mutationEvents(h).map(([type]) => type), ['request', 'set']);
  assert.equal(h.state[GRANTS_KEY][GRANT], true);
  assert.equal(h.elements.toggle.checked, true);
  assert.equal(h.elements.status.textContent, 'message:active');
});

test('denied and rejected permission requests leave opt-in off and restore the controls', async (t) => {
  const denied = await initialize(harness({ ui: 'buttons', requestResult: false }));
  await denied.elements.enable.fire('click');
  await flush();
  assert.equal(denied.state[GRANTS_KEY][GRANT], false);
  assert.equal(denied.events.some(([type, value]) => type === 'set' && value === true), false);
  assert.equal(denied.elements.enable.disabled, false);
  assert.equal(denied.elements.status.textContent, 'message:denied');

  await t.test('rejected button request', async () => {
    const rejected = await initialize(harness({ ui: 'buttons', requestError: new Error('permission API failed') }));
    await rejected.elements.enable.fire('click');
    await flush();
    assert.equal(rejected.state[GRANTS_KEY][GRANT], false);
    assert.equal(rejected.events.some(([type, value]) => type === 'set' && value === true), false);
    assert.equal(rejected.elements.enable.disabled, false);
    assert.equal(rejected.elements.status.textContent, 'message:error');
  });

  await t.test('rejected checkbox request', async () => {
    const rejected = await initialize(harness({ ui: 'toggle', requestError: new Error('permission API failed') }));
    rejected.elements.toggle.checked = true;
    await rejected.elements.toggle.fire('change');
    await flush();
    assert.equal(rejected.state[GRANTS_KEY][GRANT], false);
    assert.equal(rejected.events.some(([type, value]) => type === 'set' && value === true), false);
    assert.equal(rejected.elements.toggle.checked, false);
    assert.equal(rejected.elements.toggle.disabled, false);
    assert.equal(rejected.elements.status.textContent, 'message:error');
  });
});

test('disable persists opt-out before removing the permission for both UI shapes', async () => {
  const button = await initialize(harness({ ui: 'buttons', enabled: true, granted: true }));
  const buttonDisable = button.elements.disable.fire('click');
  await buttonDisable;
  await flush();
  assert.deepEqual(mutationEvents(button).map(([type, value]) => [type, type === 'set' ? value : undefined]), [
    ['set', false], ['remove', undefined],
  ]);
  assert.equal(button.state[GRANTS_KEY][GRANT], false);
  assert.equal(button.elements.status.textContent, 'message:inactive');

  const toggle = await initialize(harness({ ui: 'toggle', enabled: true, granted: true }));
  toggle.elements.toggle.checked = false;
  const toggleDisable = toggle.elements.toggle.fire('change');
  await toggleDisable;
  await flush();
  assert.deepEqual(mutationEvents(toggle).map(([type]) => type), ['set', 'remove']);
  assert.equal(toggle.state[GRANTS_KEY][GRANT], false);
  assert.equal(toggle.elements.status.textContent, 'message:inactive');
});

test('permission revoke failure keeps handoff off and presents a usable recovery state', async () => {
  const h = await initialize(harness({
    ui: 'buttons', enabled: true, granted: true, removeError: new Error('remove failed'),
  }));
  await h.elements.disable.fire('click');
  await flush();

  assert.equal(h.state[GRANTS_KEY][GRANT], false);
  assert.deepEqual(mutationEvents(h).map(([type, value]) => [type, type === 'set' ? value : undefined]), [
    ['set', false], ['remove', undefined],
  ]);
  assert.equal(h.elements.status.textContent, 'message:revokeError');
  assert.equal(h.elements.enable.disabled, false);
  assert.equal(h.elements.disable.disabled, false);
});

test('external opt-in changes and permission revocation refresh the UI; dispose removes observers', async () => {
  const h = await initialize(harness({ ui: 'buttons', enabled: true, granted: true }));
  const beforeUnrelated = h.events.filter(([type]) => type === 'get').length;
  h.chromeApi.storage.onChanged.fire({ unrelated: { oldValue: 1, newValue: 2 } }, 'local');
  h.chromeApi.storage.onChanged.fire({ [GRANTS_KEY]: { oldValue: true, newValue: false } }, 'sync');
  await flush();
  assert.equal(h.events.filter(([type]) => type === 'get').length, beforeUnrelated);

  h.state[GRANTS_KEY][GRANT] = false;
  h.chromeApi.storage.onChanged.fire({ [GRANTS_KEY]: { oldValue: true, newValue: false } }, 'local');
  await flush();
  assert.equal(h.elements.status.textContent, 'message:inactive');
  assert.equal(h.state[GRANTS_KEY][GRANT], false, 'external storage event reflects the new persisted opt-in');

  h.granted = false;
  h.chromeApi.permissions.onRemoved.fire({ permissions: ['cookies'], origins: [] });
  await flush();
  assert.equal(h.elements.status.textContent, 'message:inactive');
  assert.equal(h.elements.enable.disabled, false);
  assert.equal(h.elements.disable.disabled, true);

  const getCount = h.events.filter(([type]) => type === 'get').length;
  h.controller.dispose();
  assert.equal(h.chromeApi.storage.onChanged.listenerCount, 0);
  assert.equal(h.chromeApi.permissions.onAdded.listenerCount, 0);
  assert.equal(h.chromeApi.permissions.onRemoved.listenerCount, 0);
  h.chromeApi.storage.onChanged.fire({ [GRANTS_KEY]: { oldValue: true, newValue: false } }, 'local');
  h.chromeApi.permissions.onAdded.fire({ permissions: ['cookies'], origins: [] });
  await flush();
  assert.equal(h.events.filter(([type]) => type === 'get').length, getCount);
});

test('rapid repeated enable inputs share one permission request while busy', async (t) => {
  for (const ui of ['buttons', 'toggle']) {
    await t.test(ui, async () => {
      const requestGate = deferred();
      const h = await initialize(harness({ ui, requestGate }));
      if (ui === 'buttons') {
        const first = h.elements.enable.fire('click');
        const second = h.elements.enable.fire('click');
        assert.equal(h.elements.enable.disabled, true);
        requestGate.resolve(true);
        await Promise.all([first, second]);
      } else {
        h.elements.toggle.checked = true;
        const first = h.elements.toggle.fire('change');
        const second = h.elements.toggle.fire('change');
        assert.equal(h.elements.toggle.disabled, true);
        requestGate.resolve(true);
        await Promise.all([first, second]);
      }
      await flush();
      assert.equal(mutationEvents(h).filter(([type]) => type === 'request').length, 1);
      assert.equal(mutationEvents(h).filter(([type, value]) => type === 'set' && value === true).length, 1);
      assert.equal(h.state[GRANTS_KEY][GRANT], true);
    });
  }
});

test('two views serialize enable against revoke and recheck the permission before saving opt-in', async () => {
  const removeGate = deferred();
  const lockManager = sharedLockManager();
  const first = await initialize(harness({
    ui: 'buttons', enabled: true, granted: true, removeGate, lockManager,
  }));
  const secondElements = { enable: element(), disable: element(), status: element() };
  const secondController = mountGrantSettings({
    grantId: GRANT,
    chromeApi: first.chromeApi,
    lockManager,
    ...secondElements,
    message: (key) => `second:${key}`,
  });
  const second = {
    ...secondElements,
    controller: secondController,
  };
  await flush();

  const disabling = first.elements.disable.fire('click');
  for (let i = 0; i < 10 && !first.events.some(([type]) => type === 'remove'); i++) await flush();
  assert.equal(first.events.some(([type]) => type === 'remove'), true, 'revoke holds the shared lock while remove is pending');

  const enabling = second.enable.fire('click');
  assert.equal(first.events.filter(([type]) => type === 'request').length, 1,
    'permission request starts synchronously in the enable gesture');
  await flush();
  assert.deepEqual(lockManager.requests, [
    'hc-handoff-grants', 'hc-handoff-grants',
  ]);
  assert.equal(first.events.some(([type, value]) => type === 'set' && value === true), false,
    'enable waits for revoke instead of committing opt-in during removal');

  removeGate.resolve(true);
  await Promise.all([disabling, enabling]);
  await flush();

  assert.equal(first.granted, false);
  assert.equal(first.state[GRANTS_KEY][GRANT], false);
  assert.equal(first.elements.status.textContent, 'message:inactive');
  assert.equal(second.status.textContent, 'second:denied');
  assert.equal(second.enable.disabled, false);
  assert.equal(second.disable.disabled, true);
  assert.equal(first.events.filter(([type]) => type === 'request').length, 1);
  assert.equal(first.events.filter(([type]) => type === 'remove').length, 1);
  assert.equal(first.events.filter(([type, value]) => type === 'set' && value === true).length, 0,
    'the permission recheck prevents storing opt-in after revoke wins');
  assert.deepEqual(first.events.filter(([type]) => type === 'set').map(([, value]) => value), [false, false]);

  first.controller.dispose();
  second.controller.dispose();
});

test('a queued disable runs after an earlier pending enable and leaves both views off', async () => {
  const requestGate = deferred();
  const lockManager = sharedLockManager();
  const first = await initialize(harness({
    ui: 'buttons', enabled: false, granted: true, requestGate, lockManager,
  }));
  const secondElements = { enable: element(), disable: element(), status: element() };
  const secondController = mountGrantSettings({
    grantId: GRANT,
    chromeApi: first.chromeApi,
    lockManager,
    ...secondElements,
    message: (key) => `second:${key}`,
  });
  await flush();

  const enabling = first.elements.enable.fire('click');
  assert.equal(first.events.filter(([type]) => type === 'request').length, 1,
    'the permission request begins in the first view gesture');
  await flush();
  assert.deepEqual(lockManager.requests, ['hc-handoff-grants']);
  assert.deepEqual(first.events.filter(([type]) => type === 'set'), [],
    'enable waits for the permission result while holding the shared lock');

  const disabling = secondElements.disable.fire('click');
  await flush();
  assert.deepEqual(lockManager.requests, [
    'hc-handoff-grants', 'hc-handoff-grants',
  ]);
  assert.deepEqual(first.events.filter(([type]) => type === 'set'), [],
    'the later off action waits behind the pending enable transaction');

  requestGate.resolve(true);
  await Promise.all([enabling, disabling]);
  await Promise.all([first.controller.refresh(), secondController.refresh()]);

  assert.deepEqual(first.events.filter(([type]) => type === 'set').map(([, value]) => value), [true, false]);
  assert.equal(first.events.filter(([type]) => type === 'request').length, 1);
  assert.equal(first.events.filter(([type]) => type === 'remove').length, 1);
  assert.equal(first.state[GRANTS_KEY][GRANT], false);
  assert.equal(first.granted, false);
  assert.equal(first.elements.status.textContent, 'message:inactive');
  assert.equal(first.elements.enable.disabled, false);
  assert.equal(first.elements.disable.disabled, true);
  assert.equal(secondElements.status.textContent, 'second:inactive');
  assert.equal(secondElements.enable.disabled, false);
  assert.equal(secondElements.disable.disabled, true);

  first.controller.dispose();
  secondController.dispose();
});

test('turning a grant off keeps other keys in the map, and unknown ids do not keep cookie permission alive', async () => {
  const h = await initialize(harness({ ui: 'buttons', enabled: true, granted: true, extraGrants: { 'retired-grant': true } }));
  await h.elements.disable.fire('click');
  await flush();
  assert.deepEqual(h.state[GRANTS_KEY], { 'retired-grant': true, [GRANT]: false });
  assert.deepEqual(mutationEvents(h).map(([type]) => type), ['set', 'remove']);
  assert.equal(h.granted, false);
});

test('mounting a switch for an unknown grant fails loudly', () => {
  assert.throws(() => mountGrantSettings({ grantId: 'nope', chromeApi: {}, status: element(), message: String }), /unknown grant/);
});
