const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

const settle = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const resources = { peerConnectionId: 2, streamId: 'own-stream', trackIds: ['own-audio'] };
function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness({ os = 'android', version = 29, module = true, active = true, granted = true, permission } = {}) {
  const listeners = new Map(); const tasks = new Map(); const intervals = new Map();
  const calls = []; const starts = new Map(); const prompts = []; let selected = 'earpiece'; let timer = 0;
  const snapshot = () => ({ routes: [
    { id: 'earpiece', type: 'earpiece', label: 'Auricular' },
    { id: 'speaker', type: 'speaker', label: 'Altavoz' },
    { id: 'bluetooth', type: 'bluetooth', label: 'Bluetooth' },
  ], selectedRouteId: selected });
  const emit = (name, payload) => { for (const callback of [...(listeners.get(name) || [])]) callback(payload); };
  const native = {
    start(options) { calls.push(['start', options]); const pending = deferred(); starts.set(options.token, pending); return pending.promise; },
    async confirmKeepAlive(token) { calls.push(['confirm', token]); const pending = starts.get(token); if (!pending) return false; pending.resolve(snapshot()); return true; },
    heartbeat(token) { calls.push(['heartbeat', token]); },
    async stop(token) {
      calls.push(['stop', token]); const pending = starts.get(token);
      starts.delete(token); pending?.reject(Object.assign(new Error('La llamada se cerró.'), { code: 'CALL_NATIVE_CANCELLED' }));
      emit('ChatLocalCallServiceStopped', { token, reason: 'stopped' }); return true;
    },
    async update(token, value) { calls.push(['update', token, value]); return true; },
    async getAudioRoutes(token) { calls.push(['routes', token]); return snapshot(); },
    async selectAudioRoute(token, id) { calls.push(['select', token, id]); selected = id; return snapshot(); },
  };
  const appState = { currentState: active ? 'active' : 'background' };
  const reactNative = {
    Platform: { OS: os, Version: version }, NativeModules: module ? { ChatLocalCallSession: native } : {},
    AppRegistry: { registerHeadlessTask(name, factory) { tasks.set(name, factory); } }, AppState: appState,
    NativeEventEmitter: class {
      addListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
        return { remove: () => listeners.get(name).delete(callback) };
      }
    },
    PermissionsAndroid: {
      PERMISSIONS: { POST_NOTIFICATIONS: 'notification', BLUETOOTH_CONNECT: 'bluetooth' }, RESULTS: { GRANTED: 'granted' },
      async check() { return granted; },
      async request(name) { prompts.push(name); return permission ? permission(name) : 'granted'; },
    },
  };
  const filename = path.join(__dirname, '../src/calls/callNativeSession.js');
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), { filename,
    configFile: false, babelrc: false, plugins: [require('@babel/plugin-transform-modules-commonjs')] });
  const exports = {};
  vm.runInNewContext(code, { module: { exports }, exports, Date, Promise, Error,
    setInterval(callback) { const id = ++timer; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    require(name) { assert.equal(name, 'react-native'); return reactNative; },
  }, { filename });
  return { api: exports, calls, prompts, tasks, starts, intervals, appState, native, emit,
    token: () => calls.findLast(([type]) => type === 'start')?.[1].token,
    task: (token) => tasks.get('chatlocal.callKeepAlive')()({ token }),
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    async start(options = {}) {
      const pending = exports.startCallNativeSession({ kind: 'audio', nativeResources: resources, ...options });
      await settle();
      const held = this.task(this.token()); await settle();
      return { lease: await pending, held, token: this.token() };
    },
  };
}

test('web, iOS and old Android APK remain foreground-only without initializing a task or prompting', async () => {
  for (const options of [{ os: 'web' }, { os: 'ios' }, { module: false }]) {
    const h = harness(options);
    assert.equal(h.api.getCallNativeAvailability().available, false);
    assert.equal(h.tasks.size, 0);
    await assert.rejects(h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources }), { code: 'CALL_NATIVE_UNAVAILABLE' });
    assert.equal(h.calls.length, 0); assert.equal(h.prompts.length, 0);
  }
});

test('start waits for the live headless task; stop clears heartbeats and task exactly once', async () => {
  const h = harness(); let ready = false;
  const pending = h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources, peerName: 'Bob' });
  pending.then(() => { ready = true; });
  await settle(); assert.equal(ready, false);
  const token = h.token(); const held = h.task(token); let finished = false;
  held.then(() => { finished = true; }); await settle();
  const lease = await pending; assert.equal(ready, true); assert.equal(finished, false);
  assert.equal(h.intervals.size, 1);
  for (const pulse of h.intervals.values()) pulse();
  assert.deepEqual(h.calls.find(([type]) => type === 'heartbeat'), ['heartbeat', token]);
  await Promise.all([lease.stop(), lease.stop()]); await held;
  assert.equal(finished, true); assert.equal(h.intervals.size, 0); assert.equal(h.listenerCount(), 0);
  assert.equal(h.calls.filter(([type]) => type === 'stop').length, 1);
  await assert.rejects(lease.update({ muted: true }), { code: 'CALL_NATIVE_CANCELLED' });
});

test('abort during native start releases only its token and cannot affect the next call', async () => {
  const h = harness(); const controller = new AbortController();
  const pending = h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources, signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CALL_NATIVE_CANCELLED' });
  await settle(); const previous = h.token(); controller.abort(); await rejected;
  assert.deepEqual(h.calls.find(([type]) => type === 'stop'), ['stop', previous]);
  const current = await h.start();
  h.emit('ChatLocalCallHangup', { token: previous }); h.emit('ChatLocalCallServiceStopped', { token: previous });
  assert.equal(h.calls.filter(([type]) => type === 'stop').length, 1);
  await current.lease.update({ muted: true });
  assert.equal(h.calls.findLast(([type]) => type === 'update')[1], current.token);
  await current.lease.stop(); await current.held;
});

test('pre-abort, background and invalid RTC ownership do not start a service', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources, signal: controller.signal }), { code: 'CALL_NATIVE_CANCELLED' });
  await assert.rejects(h.api.startCallNativeSession({ kind: 'audio', nativeResources: { ...resources, trackIds: [] } }), { code: 'CALL_NATIVE_RESOURCES_INVALID' });
  h.appState.currentState = 'background';
  await assert.rejects(h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources }), { code: 'CALL_NATIVE_NOT_VISIBLE' });
  assert.equal(h.calls.length, 0); assert.equal(h.listenerCount(), 0);
});

test('notification hangup is delivered once and stale service events are ignored', async () => {
  const h = harness(); let hangups = 0; let stopped = 0;
  const call = await h.start({ onHangup: () => { hangups += 1; }, onServiceStopped: () => { stopped += 1; } });
  h.emit('ChatLocalCallHangup', { token: 'other-owner' });
  h.emit('ChatLocalCallHangup', { token: call.token });
  h.emit('ChatLocalCallHangup', { token: call.token });
  h.emit('ChatLocalCallServiceStopped', { token: call.token, reason: 'notification_hangup' });
  await settle(); await call.held;
  assert.equal(hangups, 1); assert.equal(stopped, 0); assert.equal(h.listenerCount(), 0);
  assert.equal(h.calls.filter(([type]) => type === 'stop').length, 1);
});

test('unexpected service termination ends the headless task and reports its reason once', async () => {
  const h = harness(); const reasons = [];
  const call = await h.start({ onServiceStopped: (event) => reasons.push(event.reason) });
  h.emit('ChatLocalCallServiceStopped', { token: call.token, reason: 'audio_focus_lost' });
  h.emit('ChatLocalCallServiceStopped', { token: call.token, reason: 'audio_focus_lost' });
  await call.held;
  assert.deepEqual(reasons, ['audio_focus_lost']); assert.equal(h.intervals.size, 0);
  assert.equal(h.calls.filter(([type]) => type === 'stop').length, 0);
});

test('only modern notification and explicitly selected Bluetooth request permissions', async () => {
  const h = harness({ version: 33, granted: false }); const changed = [];
  const call = await h.start({ onAudioRoutes: (value) => changed.push(value.selectedRouteId) });
  assert.deepEqual(h.prompts, ['notification']);
  await call.lease.selectAudioRoute('speaker'); assert.deepEqual(h.prompts, ['notification']);
  const result = await call.lease.selectAudioRoute('bluetooth');
  assert.deepEqual(h.prompts, ['notification', 'bluetooth']); assert.equal(result.selectedRouteId, 'bluetooth');
  assert.deepEqual(changed, ['earpiece', 'speaker', 'bluetooth']);
  await call.lease.stop(); await call.held;
});

test('denied notification and cancellation during its dialog never start a service', async () => {
  const denied = harness({ version: 33, granted: false, permission: () => 'denied' });
  await assert.rejects(denied.api.startCallNativeSession({ kind: 'audio', nativeResources: resources }), { code: 'CALL_NATIVE_PERMISSION_DENIED' });
  assert.equal(denied.calls.length, 0); assert.equal(denied.listenerCount(), 0);
  const permission = deferred(); const h = harness({ version: 33, granted: false, permission: () => permission.promise });
  const controller = new AbortController();
  const pending = h.api.startCallNativeSession({ kind: 'video', nativeResources: resources, signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CALL_NATIVE_CANCELLED' });
  await settle(); controller.abort(); permission.resolve('granted'); await rejected;
  assert.equal(h.calls.length, 0); assert.equal(h.listenerCount(), 0);
});

test('Bluetooth denial leaves the current route and capture intact; Android29 does not ask', async () => {
  const h = harness({ version: 31, granted: false, permission: () => 'denied' }); const call = await h.start();
  await assert.rejects(call.lease.selectAudioRoute('bluetooth'), { code: 'CALL_NATIVE_PERMISSION_DENIED' });
  assert.equal((await call.lease.getAudioRoutes()).selectedRouteId, 'earpiece');
  assert.equal(h.calls.filter(([type]) => type === 'select').length, 0);
  await call.lease.stop(); await call.held;
  const legacy = harness({ version: 29, granted: false }); const previous = await legacy.start();
  await previous.lease.selectAudioRoute('bluetooth'); assert.deepEqual(legacy.prompts, []);
  await previous.lease.stop(); await previous.held;
});

test('single-flight includes a pending start and unowned headless tasks close their own token', async () => {
  const h = harness(); const pending = h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources });
  await settle();
  await assert.rejects(h.api.startCallNativeSession({ kind: 'video', nativeResources: resources }), { code: 'CALL_NATIVE_BUSY' });
  await h.task('foreign-call'); assert.deepEqual(h.calls.find(([type]) => type === 'stop'), ['stop', 'foreign-call']);
  const held = h.task(h.token()); const lease = await pending; await lease.stop(); await held;
});

test('repeated headless delivery shares one heartbeat and settles every task on stop', async () => {
  const h = harness(); const call = await h.start();
  const repeated = h.task(call.token); await settle();
  assert.equal(h.intervals.size, 1);
  assert.equal(h.calls.filter(([type]) => type === 'confirm').length, 1);
  await call.lease.stop(); await Promise.all([call.held, repeated]);
  assert.equal(h.intervals.size, 0);
});

test('failed native startup preserves its error even when cleanup fails', async () => {
  const h = harness();
  h.native.start = async () => { throw Object.assign(new Error('No se pudo iniciar el servicio.'), { code: 'CALL_NATIVE_START_FAILED' }); };
  h.native.stop = async () => { throw new Error('Bridge detenido'); };
  await assert.rejects(h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources }), { code: 'CALL_NATIVE_START_FAILED' });
  assert.equal(h.listenerCount(), 0); assert.equal(h.intervals.size, 0);
  await h.task('orphan-token');
});

test('headless confirmation failure still finishes the task if native stop and UI callback fail', async () => {
  const h = harness();
  h.native.confirmKeepAlive = async () => { throw new Error('No se pudo confirmar el servicio.'); };
  h.native.stop = async () => { throw new Error('Bridge detenido'); };
  const pending = h.api.startCallNativeSession({ kind: 'audio', nativeResources: resources,
    onServiceStopped() { throw new Error('UI desmontada'); } });
  const rejected = assert.rejects(pending, { code: 'CALL_NATIVE_START_FAILED' });
  await settle(); const token = h.token();
  await h.task(token);
  h.starts.get(token).reject(Object.assign(new Error('No se pudo mantener la llamada en segundo plano.'), { code: 'CALL_NATIVE_START_FAILED' }));
  await rejected;
  assert.equal(h.listenerCount(), 0); assert.equal(h.intervals.size, 0);
});

test('device disconnect updates current output and never advertises an unavailable selected route', async () => {
  const h = harness(); const changes = [];
  const call = await h.start({ onAudioRoutes: (value) => changes.push(value) });
  const routes = [{ id: 'earpiece', type: 'earpiece', label: 'Auricular' },
    { id: 'wired:21', type: 'wired', label: 'Audífonos conectados' }];
  h.emit('ChatLocalCallAudioRoutes', { token: call.token, routes, selectedRouteId: 'wired:21' });
  assert.equal(changes.at(-1).selectedRouteId, 'wired:21');
  h.emit('ChatLocalCallAudioRoutes', { token: call.token, routes: routes.slice(0, 1), selectedRouteId: 'earpiece' });
  assert.equal(changes.at(-1).selectedRouteId, 'earpiece');
  // Android device-disconnect callbacks can briefly precede its route update.
  h.emit('ChatLocalCallAudioRoutes', { token: call.token, routes: routes.slice(0, 1), selectedRouteId: 'wired:21' });
  assert.equal(changes.at(-1).selectedRouteId, null);
  await call.lease.stop(); await call.held;
});
