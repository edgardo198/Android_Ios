const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const cache = new Map();

function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, '..', relative);
  if (!cache.has(filename)) cache.set(filename, babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }], require('@babel/plugin-transform-modules-commonjs')],
  }).code);
  const module = { exports: {} };
  vm.runInNewContext(cache.get(filename), { module, exports: module.exports, URL, Date, AbortController, setTimeout, clearTimeout,
    require(name) { if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`); return mocks[name]; }, ...globals,
  }, { filename });
  return module.exports;
}
const core = load('src/notifications/noticeCoordinator.js');
const DEVICE = '6f498606-7027-4a65-bf68-37da92e984d0';
const CALL = 'bc5c6f2f-a2dc-4a45-ab3b-763eb95b5f4f';
const START = Date.parse('2026-10-11T15:00:00Z');
const clone = (value) => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); }

function harness(options = {}) {
  let time = START, generation = 1, appState = options.appState || 'active', appListener, nativeListener, openListener;
  let navReady = options.navReady !== false, route = options.route ?? 1;
  const timers = new Map(), subscriptions = new Set(), calls = [], registrations = [], revocations = [], opens = [], snapshots = [];
  let timerId = 0;
  let state = { initialized: true, authenticated: true, outboxIdentityVerified: true,
    user: { id: 11, username: 'Alice', authVersion: 2 }, messagesConnectionId: 99,
    friendList: [{ id: 1, friend: { username: 'Bob', name: 'Bob' } }], ...options.state };
  const store = { getState() { return { ...state,
    captureAuthSession: () => state.authenticated ? { generation, username: state.user.username, userId: state.user.id } : null,
    isAuthSessionCurrent: (snapshot) => !!snapshot && state.authenticated && snapshot.generation === generation &&
      snapshot.username === state.user?.username && String(snapshot.userId) === String(state.user?.id),
  }; }, subscribe(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); } };
  const setState = (update, newSession = false) => {
    if (newSession) generation++;
    const previous = store.getState(); state = { ...state, ...update };
    subscriptions.forEach((listener) => listener(store.getState(), previous));
  };
  const preferences = new Map(options.preferences || []);
  let saved = options.saved || { deviceId: DEVICE, userId: '', authVersion: '', expiresAt: '' };
  let nativeState = options.nativeState || { enabled: false, running: false, connected: false, userId: '', authVersion: '' };
  const native = {};
  const methods = {
    async getPreference(username) { return preferences.get(username) ?? true; },
    async setPreference(username, enabled) { preferences.set(username, enabled); return true; },
    async getPermission() { return options.permission !== false; },
    async requestPermission() { return options.granted === true; },
    async getRegistration() { return saved; }, async getState() { return nativeState; },
    async getPendingOpen() { return options.pendingOpen || null; },
    async resume() { nativeState = { ...nativeState, enabled: true, running: true }; return true; },
    async setForeground() {},
    async stop() { saved = { deviceId: DEVICE, userId: '', expiresAt: '', authVersion: '' };
      nativeState = { enabled: false, running: false, connected: false, userId: '', authVersion: '' }; },
    async configure(config) {
      saved = { deviceId: config.deviceId, userId: config.userId, expiresAt: config.expiresAt, authVersion: config.authVersion };
      nativeState = { ...saved, enabled: true, running: true, connected: true };
    },
    ...options.native,
  };
  for (const [name, action] of Object.entries(methods)) native[name] = (...args) => { calls.push({ name, args }); return action(...args); };
  const registration = (body) => ({ deviceId: body.deviceId, deviceToken: `ndv_${'a'.repeat(43)}`, expiresAt: new Date(time + 3600000).toISOString() });
  const instance = core.createNoticeCoordinator({ store, native, available: options.available !== false,
    reason: options.available === false ? 'No disponible' : null,
    registerDevice: async (body, signal) => {
      registrations.push({ body, signal, user: state.user?.username });
      return options.register ? options.register(body, signal, registration) : registration(body);
    },
    revokeDevice: async (data) => { revocations.push(data); },
    getWsUrl: async () => 'ws://127.0.0.1:8030/', randomUUID: () => DEVICE,
    getAppState: () => appState, subscribeAppState(listener) { appListener = listener; return () => { appListener = null; }; },
    subscribeNative(onState, onOpen) { nativeListener = onState; openListener = onOpen;
      return () => { nativeListener = openListener = null; }; },
    getForegroundConnection: () => route,
    canOpen: () => navReady,
    onOpen(event) { opens.push(event); if (options.onOpen) return options.onOpen(instance, event); return true; },
    onState(value) { snapshots.push(clone(value)); }, now: () => time,
    setTimer(action, delay) { const id = ++timerId; timers.set(id, { at: time + delay, action }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { instance, store, native, calls, registrations, revocations, opens, snapshots, preferences,
    setState, registration, nativeState: () => nativeState,
    async start() { instance.start(); await settle(); },
    async app(value) { appState = value; appListener?.(); await settle(); },
    nativeEvent(value) { nativeListener?.(value); },
    openEvent(value) { openListener?.(value); },
    setRoute(value) { route = value; instance.flushOpen(); },
    ready(value = true) { navReady = value; instance.flushOpen(); },
    async advance(delta) {
      const target = time + delta;
      for (let i = 0; i < 30; i++) {
        const first = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        timers.delete(first[0]); time = first[1].at; await first[1].action(); await settle();
      }
      time = target; await settle();
    },
    timerDelays: () => [...timers.values()].map((timer) => timer.at - time),
  };
}
const named = (h, name) => h.calls.filter((call) => call.name === name);

test('registration waits for a verified own profile and passes only a scoped device credential to Android', async () => {
  const h = harness({ state: { outboxIdentityVerified: false } });
  await h.start();
  assert.equal(h.registrations.length, 0);
  assert.equal(named(h, 'configure').length, 0);
  h.setState({ outboxIdentityVerified: true }); await settle();
  assert.equal(h.registrations.length, 1);
  const config = named(h, 'configure')[0].args[0];
  assert.equal(config.token, `ndv_${'a'.repeat(43)}`);
  assert.equal(config.userId, '11'); assert.equal(config.username, 'Alice'); assert.equal(config.authVersion, '2');
  assert.equal(config.wsUrl, 'ws://127.0.0.1:8030/ws/device-events/');
  assert.deepEqual(clone(h.registrations[0].body), { deviceId: DEVICE, platform: 'android' });
  assert.equal(JSON.stringify(h.snapshots).includes('ndv_'), false);
  h.nativeEvent({ ...h.nativeState(), connected: true });
  assert.equal(h.instance.getState().connected, true);
  h.instance.dispose();
});

test('unsupported runtimes never touch native permissions, storage, registration or listeners', async () => {
  const h = harness({ available: false }); await h.start();
  await h.instance.retry(); h.instance.flushOpen(); h.instance.dispose();
  assert.equal(h.calls.length, 0); assert.equal(h.registrations.length, 0);
  assert.equal(h.instance.getState().available, false);
});

test('permission denial has no device registration, and explicit retry can enable receipt', async () => {
  let granted = false;
  const h = harness({ permission: false, native: { async requestPermission() { return granted; } } });
  await h.start();
  assert.equal(named(h, 'requestPermission').length, 1); assert.equal(h.registrations.length, 0);
  assert.match(h.instance.getState().error, /Permite las notificaciones/);
  h.setState({ friendList: [] }); await settle();
  assert.equal(named(h, 'requestPermission').length, 1);
  granted = true; assert.equal(await h.instance.retry(), true); await settle();
  assert.equal(h.registrations.length, 1); assert.equal(named(h, 'configure').length, 1);
  h.instance.dispose();
});

test('a background app neither requests permissions nor creates a device; activation resumes on foreground', async () => {
  const h = harness({ appState: 'background', permission: false, granted: true }); await h.start();
  assert.equal(named(h, 'requestPermission').length, 0); assert.equal(h.registrations.length, 0);
  await h.app('active');
  assert.equal(named(h, 'requestPermission').length, 1); assert.equal(h.registrations.length, 1);
  h.instance.dispose();
});

test('logout during registration aborts and revokes the late scoped token without configuring another session', async () => {
  const result = deferred(), h = harness({ register: () => result.promise }); await h.start();
  assert.equal(h.registrations.length, 1);
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  assert.equal(h.registrations[0].signal.aborted, true);
  h.setState({ authenticated: true, user: { id: 12, username: 'Bob', authVersion: 2 }, outboxIdentityVerified: false }, true);
  result.resolve(h.registration({ deviceId: DEVICE })); await settle();
  assert.equal(named(h, 'configure').length, 0); assert.equal(h.revocations.length, 1);
  assert.equal(h.instance.getState().ready, false);
  h.instance.dispose();
});

test('a late native configure is stopped before a new login of the same account can configure', async () => {
  const first = deferred(); let count = 0;
  const h = harness({ native: { async configure() { if (++count === 1) await first.promise; } } });
  await h.start(); assert.equal(count, 1);
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  h.setState({ authenticated: true, user: { id: 11, username: 'Alice', authVersion: 2 }, outboxIdentityVerified: true }, true);
  await settle(); assert.equal(count, 1);
  first.resolve(); await settle();
  assert.equal(count, 2); assert.equal(h.revocations.length, 1);
  const names = h.calls.map(({ name }) => name), firstConfig = names.indexOf('configure'), lastConfig = names.lastIndexOf('configure');
  assert.ok(names.slice(firstConfig + 1, lastConfig).includes('stop'));
  assert.equal(h.instance.getState().ready, true); assert.equal(h.instance.getState().error, null);
  h.instance.dispose();
});

test('logout stops a running receiver synchronously before asynchronous session storage cleanup', async () => {
  const h = harness(); await h.start(); h.nativeEvent(h.nativeState()); await settle();
  const stops = named(h, 'stop').length;
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  assert.ok(named(h, 'stop').length > stops);
  assert.equal(h.instance.getState().running, false); assert.equal(h.instance.getState().ready, false);
  await settle(); h.instance.dispose();
});

test('saved disabled preference stays disabled, and failed disable writes retry without re-enabling receipt', async () => {
  let writes = 0;
  const h = harness({ preferences: [['Alice', false]], native: {
    async setPreference(username, enabled) { writes++; if (writes === 1) return false; h.preferences.set(username, enabled); return true; },
  } }); await h.start();
  assert.equal(h.registrations.length, 0); assert.equal(h.instance.getState().enabled, false);
  assert.equal(await h.instance.setEnabled(false), false);
  assert.equal(h.instance.getState().enabled, false); assert.match(h.instance.getState().error, /guardar/);
  assert.equal(await h.instance.retry(), true);
  assert.equal(h.instance.getState().error, null); assert.equal(h.registrations.length, 0);
  assert.equal(await h.instance.setEnabled(true), true); await settle();
  assert.equal(h.preferences.get('Alice'), true); assert.equal(h.registrations.length, 1);
  const off = named(h, 'stop').length;
  const saving = h.instance.setEnabled(false);
  assert.ok(named(h, 'stop').length > off); assert.equal(h.instance.getState().running, false);
  await saving; h.instance.dispose();
});

test('a delayed preference write from Alice cannot block or change the case-distinct new account alice', async () => {
  const write = deferred();
  const h = harness({ native: { async setPreference(username) { if (username === 'Alice') await write.promise; return true; } } });
  await h.start(); const saving = h.instance.setEnabled(false); await settle();
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  h.setState({ authenticated: true, user: { id: 13, username: 'alice', authVersion: 0 }, outboxIdentityVerified: true }, true);
  write.resolve(); await saving; await settle();
  assert.equal(named(h, 'configure').at(-1).args[0].username, 'alice');
  assert.equal(h.instance.getState().enabled, true); assert.equal(h.instance.getState().changing, false);
  h.instance.dispose();
});

test('a live saved receiver is reused only for the verified user and current authVersion', async () => {
  for (const version of ['2', '1']) {
    const saved = { deviceId: DEVICE, userId: '11', authVersion: version, expiresAt: new Date(START + 3600000).toISOString() };
    const h = harness({ saved, nativeState: { ...saved, enabled: true, running: true, connected: true } }); await h.start();
    assert.equal(h.registrations.length, version === '2' ? 0 : 1);
    if (version === '2') assert.equal(h.instance.getState().connected, true);
    else assert.equal(named(h, 'configure').at(-1).args[0].authVersion, '2');
    h.instance.dispose();
  }
});

test('a stopped service resumes the durable current credential without registering or revoking its offline cursor', async () => {
  const saved = { deviceId: DEVICE, userId: '11', authVersion: '2', expiresAt: new Date(START + 3600000).toISOString() };
  const h = harness({ saved, nativeState: { ...saved, enabled: true, running: false, connected: false } }); await h.start();
  assert.equal(h.registrations.length, 0); assert.equal(h.revocations.length, 0); assert.equal(named(h, 'stop').length, 0);
  assert.deepEqual(clone(named(h, 'resume')[0].args), ['11', '2']);
  assert.equal(h.instance.getState().starting, true);
  h.nativeEvent({ ...saved, running: true, connected: true });
  assert.equal(h.instance.getState().starting, false); assert.equal(h.instance.getState().connected, true);
  h.instance.dispose();
});

test('near-expiry credential rotation retains the previous registration while awaiting the replacement', async () => {
  const result = deferred();
  const saved = { deviceId: DEVICE, userId: '11', authVersion: '2', expiresAt: new Date(START + 30000).toISOString() };
  const h = harness({ saved, nativeState: { ...saved, enabled: true, running: true, connected: true }, register: () => result.promise }); await h.start();
  assert.equal(h.registrations.length, 1); assert.equal(named(h, 'stop').length, 0); assert.equal(h.revocations.length, 0);
  result.resolve(h.registration({ deviceId: DEVICE })); await settle();
  assert.equal(named(h, 'configure').length, 1); assert.equal(named(h, 'stop').length, 0); assert.equal(h.revocations.length, 0);
  h.instance.dispose();
});

test('the default thirty-day credential uses bounded timer checks without overflowing into continuous reactivation', async () => {
  const saved = { deviceId: DEVICE, userId: '11', authVersion: '2', expiresAt: new Date(START + 30 * 86400000).toISOString() };
  const h = harness({ saved, nativeState: { ...saved, enabled: true, running: true, connected: true } }); await h.start();
  assert.ok(h.timerDelays().every((delay) => delay > 0 && delay <= 86400000));
  await h.advance(86400000);
  assert.equal(h.registrations.length, 0); assert.equal(named(h, 'configure').length, 0);
  assert.equal(h.instance.getState().running, true); h.instance.dispose();
});

test('failure after native configuration starts clears native credentials and revokes the returned device token', async () => {
  const h = harness({ native: { async configure() { throw new Error('native scheduled start failed'); } } }); await h.start();
  const names = h.calls.map(({ name }) => name);
  assert.ok(names.lastIndexOf('stop') > names.indexOf('configure'));
  assert.equal(h.revocations.length, 1); assert.match(h.instance.getState().error, /No se pudo activar/);
  h.instance.dispose();
});

test('foreground route changes suppress only the visible chat; background and UI teardown retain the receiver', async () => {
  const h = harness({ route: 1 }); await h.start(); h.nativeEvent(h.nativeState()); await settle();
  const stops = named(h, 'stop').length;
  h.setRoute(2); await settle(); assert.deepEqual(clone(named(h, 'setForeground').at(-1).args), [true, '2']);
  h.setRoute(null); await settle(); assert.deepEqual(clone(named(h, 'setForeground').at(-1).args), [true, null]);
  await h.app('background'); assert.deepEqual(clone(named(h, 'setForeground').at(-1).args), [false, null]);
  assert.equal(named(h, 'stop').length, stops); assert.equal(h.instance.getState().running, true);
  h.instance.dispose(); await settle(); assert.equal(named(h, 'stop').length, stops);
});

test('an expired background credential is renewed only after returning to the foreground', async () => {
  const h = harness(); await h.start(); h.nativeEvent(h.nativeState());
  await h.app('background'); await h.advance(3600000);
  assert.equal(h.registrations.length, 1); assert.equal(h.instance.getState().running, false);
  await h.app('active'); assert.equal(h.registrations.length, 2);
  h.instance.dispose();
});

test('notification navigation waits for verified ownership, navigation and the actual friend connection', async () => {
  const h = harness({ navReady: false, state: { friendList: [] } }); await h.start();
  h.openEvent({ noticeUserId: '11', noticeEventId: '81', connectionId: '1', callId: CALL });
  h.ready(); assert.equal(h.opens.length, 0);
  h.setState({ friendList: [{ id: 1, friend: { username: 'Bob', name: 'Bobby' } }] }); await settle();
  assert.equal(h.opens.length, 1); assert.equal(h.opens[0].friend.name, 'Bobby'); assert.equal(h.opens[0].connectionId, 1);
  h.openEvent({ noticeUserId: '11', noticeEventId: '81', connectionId: '1', callId: CALL });
  h.openEvent({ noticeUserId: '12', noticeEventId: '82', connectionId: '1' });
  h.openEvent({ noticeUserId: '11', noticeEventId: '../83', connectionId: '1' });
  h.openEvent({ noticeUserId: '11', noticeEventId: '84', connectionId: '2' });
  assert.equal(h.opens.length, 1);
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  h.setState({ authenticated: true, user: { id: 12, username: 'Bob', authVersion: 0 }, outboxIdentityVerified: true,
    friendList: [{ id: 2, friend: { username: 'Alice' } }] }, true); await settle();
  assert.equal(h.opens.length, 1); h.instance.dispose();
});

test('navigation callbacks can flush again without opening or accepting a call twice', async () => {
  const h = harness({ onOpen(instance) { instance.flushOpen(); return true; } }); await h.start();
  h.openEvent({ noticeUserId: '11', noticeEventId: '91', connectionId: '1', callId: CALL });
  assert.equal(h.opens.length, 1); assert.equal(h.instance.flushOpen(), false);
  h.instance.dispose();
});

test('a tapped notice received while backgrounded waits for the active UI before navigating', async () => {
  const h = harness({ appState: 'background' }); await h.start();
  h.openEvent({ noticeUserId: '11', noticeEventId: '93', connectionId: '1' });
  assert.equal(h.opens.length, 0);
  await h.app('active'); assert.equal(h.opens.length, 1); h.instance.dispose();
});

function hooksHarness() {
  const slots = [], updates = [];
  let cursor = 0, effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const at = cursor++; if (!(at in slots)) slots[at] = initial;
      return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; updates.push(slots[at]); }];
    },
    useEffect(effect, dependencies) {
      const at = cursor++, previous = slots[at];
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
        effects.push(() => { previous?.cleanup?.(); slots[at] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  return { react, updates, render(Component, props) { cursor = 0; effects = []; const tree = Component(props); effects.forEach((effect) => effect()); return tree; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
const uiMocks = { StyleSheet: { create: (value) => value }, Text: 'Text', View: 'View', TouchableOpacity: 'TouchableOpacity' };

test('the Profile switch can stop ongoing activation, blocks duplicate saves, and retries a failed disabled preference', async () => {
  const h = hooksHarness(), changes = [], retries = [];
  let state = { available: true, ready: true, enabled: true, changing: false, loading: true, starting: true, connected: false };
  const Settings = load('src/notifications/BackgroundNoticeSettings.jsx', {
    react: h.react, 'react-native': { ...uiMocks, Platform: { OS: 'android' } }, './BackgroundNotices': {
      useBackgroundNoticeState: () => state,
      async setBackgroundNoticesEnabled(value) { changes.push(value); state = { ...state, enabled: value, changing: true }; },
      async retryBackgroundNotices() { retries.push(true); },
    },
  }).default;
  const render = () => h.render(Settings, { embedded: true });
  const control = (tree) => nodes(tree, (node) => node.props.accessibilityRole === 'switch')[0];
  assert.equal(control(render()).props.disabled, false);
  control(render()).props.onPress(); await settle();
  assert.deepEqual(changes, [false]); assert.equal(control(render()).props.disabled, true);
  state = { ...state, changing: false, loading: false, starting: false, error: 'No se pudo guardar tu elección.' };
  const retry = nodes(render(), (node) => node.props.accessibilityLabel === 'Reintentar recepción de avisos')[0];
  assert.equal(retry.props.disabled, false); retry.props.onPress(); await settle();
  assert.deepEqual(retries, [true]);
  state = { ...state, ready: false }; assert.equal(control(render()).props.disabled, true);
  h.unmount();
});

test('web Profile provides the availability explanation without dead controls or permission requests', () => {
  const h = hooksHarness();
  const Settings = load('src/notifications/BackgroundNoticeSettings.jsx', {
    react: h.react, 'react-native': { ...uiMocks, Platform: { OS: 'web' } }, './BackgroundNotices': {
      useBackgroundNoticeState: () => ({ available: false, reason: 'Mantén la app abierta.' }),
      setBackgroundNoticesEnabled() { assert.fail('unsupported native activation'); }, retryBackgroundNotices() { assert.fail('unsupported retry'); },
    },
  }).default;
  const tree = h.render(Settings);
  assert.equal(nodes(tree, (node) => node.type === 'TouchableOpacity').length, 0);
  assert.equal(nodes(tree, (node) => node.props.accessibilityRole === 'alert').length, 0);
  assert.ok(nodes(tree, (node) => node.type === 'Text').some((node) => node.props.children.includes('Mantén la app abierta.')));
  h.unmount();
});

function wrapperHarness({ platform = 'android', go = false, storeClient = false, register, token } = {}) {
  const h = harness(), hooks = hooksHarness(), events = new Map(), posts = [], deletes = [], tokenRequests = [];
  const NativeModules = {};
  Object.defineProperty(NativeModules, 'ChatLocalNotices', { get() {
    if (platform !== 'android' || go) assert.fail('native receiver evaluated in an unsupported runtime');
    return h.native;
  } });
  const app = { currentState: 'active', addEventListener() { return { remove() {} }; } };
  const fetchMock = async (url, config) => {
    if (config.method === 'DELETE') { deletes.push({ url, config }); return { ok: true, status: 204 }; }
    assert.equal(config.method, 'POST');
    const body = JSON.parse(config.body); posts.push({ url, body, config });
    if (register) return register(body, config);
    return { ok: true, status: 201, async json() {
      return { deviceId: body.deviceId, deviceToken: `ndv_${'b'.repeat(43)}`, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    } };
  };
  const wrapper = load('src/notifications/BackgroundNotices.js', {
    react: hooks.react, 'react-native': { AppState: app, NativeModules, Platform: { OS: platform },
      NativeEventEmitter: class { addListener(name, callback) { events.set(name, callback); return { remove() { events.delete(name); } }; } } },
    expo: { isRunningInExpoGo: () => go }, 'expo-constants': { executionEnvironment: storeClient ? 'storeClient' : 'standalone' },
    'expo-crypto': { randomUUID: () => DEVICE }, '../core/api': {
      async getAccessToken(force = false) { tokenRequests.push(force); return token ? token(force) : 'jwt-fixture-original'; },
      getApiBaseUrl: async () => 'http://127.0.0.1:8030', getWsBaseUrl: async () => 'ws://127.0.0.1:8030' },
    '../core/global': h.store, './noticeCoordinator': core,
  }, { fetch: fetchMock });
  let route = { name: 'Messages', params: { id: 1 } }, navReady = true, routeNames = ['Home', 'Messages', 'ResetPassword'];
  const navigations = [], navigationRef = { current: { isReady: () => navReady, getCurrentRoute: () => route,
    getRootState: () => ({ routeNames }),
    navigate(...args) { navigations.push(args); wrapper.flushPendingNoticeOpen(); } } };
  return { ...h, hooks, wrapper, posts, deletes, events, navigations, tokenRequests,
    async mount() { hooks.render(wrapper.default, { navigationRef }); await settle(); },
    route(value) { route = value; wrapper.flushPendingNoticeOpen(); },
    ready(value) { navReady = value; wrapper.flushPendingNoticeOpen(); },
    routeNames(value) { routeNames = value; wrapper.flushPendingNoticeOpen(); },
  };
}

test('the actual bridge wrapper stays inert in web and Expo Go without importing notification libraries', async () => {
  for (const runtime of [{ platform: 'web' }, { go: true, storeClient: true }]) {
    const h = wrapperHarness(runtime); await h.mount();
    assert.equal(h.wrapper.getBackgroundNoticeState().available, false);
    assert.equal(h.calls.length, 0); assert.equal(h.posts.length, 0); assert.equal(h.events.size, 0);
    assert.equal(h.wrapper.flushPendingNoticeOpen(), false); h.hooks.unmount();
  }
});

test('the actual bridge registers scoped credentials and flushes the real navigation route even without a pending notice', async () => {
  const h = wrapperHarness({ storeClient: true }); await h.mount();
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].url, 'http://127.0.0.1:8030/notifications/devices/');
  assert.equal(named(h, 'configure')[0].args[0].token, `ndv_${'b'.repeat(43)}`);
  assert.equal(named(h, 'configure')[0].args[0].authVersion, '2');
  h.route({ name: 'Profile' }); await settle(); assert.deepEqual(clone(named(h, 'setForeground').at(-1).args), [true, null]);
  h.route({ name: 'Messages', params: { id: 1 } }); await settle(); assert.deepEqual(clone(named(h, 'setForeground').at(-1).args), [true, '1']);
  h.events.get('ChatLocalNoticeOpen')({ noticeUserId: '11', noticeEventId: '102', connectionId: '1', callId: CALL });
  assert.deepEqual(clone(h.navigations), [['Messages', { id: 1, friend: { username: 'Bob', name: 'Bob' } }]]);
  assert.equal(JSON.stringify(h.wrapper.getBackgroundNoticeState()).includes('ndv_'), false);
  h.hooks.unmount(); await settle(); assert.equal(h.events.size, 0);
});

test('a ready navigation container still defers private notice routing until the authenticated stack is installed', async () => {
  const h = wrapperHarness(); await h.mount();
  h.routeNames(['SignIn', 'SignUp', 'ForgotPassword', 'ResetPassword']);
  h.events.get('ChatLocalNoticeOpen')({ noticeUserId: '11', noticeEventId: '103', connectionId: '1' });
  assert.equal(h.navigations.length, 0);
  h.routeNames(['Home', 'Messages', 'ResetPassword']); assert.equal(h.navigations.length, 1);
  h.hooks.unmount();
});

test('the bridge revokes a late response with its scoped token and captured API origin rather than the new session JWT', async () => {
  const late = deferred(), h = wrapperHarness({ register: () => late.promise }); await h.mount();
  assert.equal(h.posts.length, 1);
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  h.setState({ authenticated: true, user: { id: 12, username: 'Bob', authVersion: 1 }, outboxIdentityVerified: false }, true);
  assert.equal(h.posts[0].config.signal.aborted, false);
  late.resolve({ ok: true, status: 201, async json() {
    return { deviceId: DEVICE, deviceToken: `ndv_${'c'.repeat(43)}`, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  } });
  await settle();
  assert.equal(named(h, 'configure').length, 0); assert.equal(h.deletes.length, 1);
  assert.equal(h.deletes[0].url, `http://127.0.0.1:8030/notifications/devices/${DEVICE}/`);
  assert.equal(h.deletes[0].config.method, 'DELETE');
  assert.equal(h.deletes[0].config.headers.Authorization, `Bearer ndv_${'c'.repeat(43)}`);
  assert.equal(h.posts[0].config.headers.Authorization, 'Bearer jwt-fixture-original');
  assert.deepEqual(h.tokenRequests, [false]);
  assert.equal(h.posts.length, 1); h.hooks.unmount();
});

test('device registration refreshes a current expired JWT once while keeping JWTs out of native configuration', async () => {
  let requests = 0;
  const h = wrapperHarness({ token: (force) => force ? 'jwt-refreshed' : 'jwt-expired',
    register: async (body) => ++requests === 1 ? { status: 401, ok: false } : {
      status: 201, ok: true, async json() { return { deviceId: body.deviceId, deviceToken: `ndv_${'d'.repeat(43)}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString() }; },
    },
  }); await h.mount();
  assert.deepEqual(h.tokenRequests, [false, true]); assert.equal(h.posts.length, 2);
  assert.equal(h.posts[0].config.headers.Authorization, 'Bearer jwt-expired');
  assert.equal(h.posts[1].config.headers.Authorization, 'Bearer jwt-refreshed');
  assert.equal(named(h, 'configure')[0].args[0].token.startsWith('ndv_'), true);
  h.hooks.unmount();
});

test('a late 401 from another session never refreshes or logs out the new account', async () => {
  const late = deferred(), h = wrapperHarness({ register: () => late.promise }); let logouts = 0;
  h.setState({ logout: async () => { logouts++; } }); await h.mount();
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  h.setState({ authenticated: true, user: { id: 12, username: 'Bob', authVersion: 0 }, outboxIdentityVerified: false }, true);
  late.resolve({ ok: false, status: 401 }); await settle();
  assert.deepEqual(h.tokenRequests, [false]); assert.equal(h.posts.length, 1); assert.equal(logouts, 0);
  assert.equal(h.store.getState().authenticated, true); assert.equal(h.store.getState().user.username, 'Bob');
  h.hooks.unmount();
});

test('a second current-session registration 401 ends that session and never installs a device credential', async () => {
  const h = wrapperHarness({ register: async () => ({ ok: false, status: 401 }) }); let logouts = 0;
  h.setState({ logout: async () => {
    logouts++; h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  } }); await h.mount();
  assert.equal(logouts, 1); assert.deepEqual(h.tokenRequests, [false, true]); assert.equal(h.posts.length, 2);
  assert.equal(named(h, 'configure').length, 0); assert.equal(h.store.getState().authenticated, false);
  h.hooks.unmount();
});

test('logout during token resolution prevents dispatch instead of registering with a stale or new account JWT', async () => {
  const token = deferred(), h = wrapperHarness({ token: () => token.promise }); await h.mount();
  assert.equal(h.posts.length, 0);
  h.setState({ authenticated: false, user: null, outboxIdentityVerified: false }, true);
  h.setState({ authenticated: true, user: { id: 12, username: 'Bob', authVersion: 0 }, outboxIdentityVerified: false }, true);
  token.resolve('jwt-old-captured'); await settle();
  assert.equal(h.posts.length, 0); assert.equal(named(h, 'configure').length, 0); h.hooks.unmount();
});
