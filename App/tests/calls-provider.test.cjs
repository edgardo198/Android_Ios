const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

const settle = async () => { for (let step = 0; step < 30; step += 1) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function load(relativePath, mocks, globals = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
      require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, AbortController, ...globals,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}

/** Zustand updates synchronously; hook state changes deliberately do not render. */
function harness(options = {}) {
  const slots = [];
  let cursor = 0;
  let pendingEffects = [];
  let renderCount = 0;
  let store = { authenticated: options.authenticated !== false, user: { username: 'alice' } };
  let serverCall = null;
  let client;
  let sequence = 0;
  let timerId = 0;
  let unmounted = false;
  const timers = new Map();
  const storeListeners = new Set();
  const appListeners = new Set();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const events = [];
  const sockets = [];
  const captures = [];
  const media = [];
  const nativeSessions = [];
  const clientListeners = new Set();
  const timer = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  const adapter = load('src/calls/callClient.js', {}, {
    setTimeout: timer, setInterval: timer,
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
  });
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: () => ({ Provider: 'CallsContext.Provider' }),
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const useGlobal = () => { throw new Error('Provider must observe session changes synchronously, independently of React selectors'); };
  useGlobal.getState = () => store;
  useGlobal.subscribe = (listener) => { storeListeners.add(listener); return () => storeListeners.delete(listener); };
  const AppState = {
    currentState: options.initialAppState || 'active',
    addEventListener(name, listener) { assert.equal(name, 'change'); appListeners.add(listener); return { remove: () => appListeners.delete(listener) }; },
  };
  const register = (listeners, name, callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
  };
  const document = {
    visibilityState: options.visibility || 'visible',
    addEventListener: (name, callback) => register(documentListeners, name, callback),
    removeEventListener: (name, callback) => documentListeners.get(name)?.delete(callback),
  };
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value) {
      const payload = JSON.parse(value); this.sent.push(payload);
      if (payload.type === 'call.end' && payload.callId === serverCall?.id) serverCall = null;
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const api = async ({ method, url, data }) => {
    if (method === 'GET') return { data: { call: serverCall, iceServers: [] } };
    if (url === '/calls/') {
      serverCall = { id: `call-${++sequence}`, kind: data.kind, status: 'ringing', version: 1,
        caller: { username: 'alice' }, callee: { username: 'bob' }, callerDeviceId: data.deviceId, acceptedDeviceId: null };
      return { data: { call: serverCall } };
    }
    return { data: { call: null } };
  };
  const createRtcSession = async (config) => {
    captures.push(config);
    const audio = { enabled: true, stops: 0, readyState: 'live', stop() { this.stops += 1; this.readyState = 'ended'; } };
    const stream = { getTracks: () => [audio] };
    const rtc = {
      audio, stream, closes: 0, closed: false,
      close() {
        if (this.closed) return;
        this.closed = true; this.closes += 1; audio.stop(); events.push('rtc:closed');
      },
      offer: async () => ({ type: 'offer', sdp: 'v=0\nmock' }),
      receiveDescription: async () => null,
      addCandidate: async () => true,
      setMicrophoneEnabled: () => true, switchCamera: async () => true,
      setCameraEnabled: () => true,
      getNativeResourceIds: () => ({ peerConnectionId: 10, streamId: 'own-local-stream', trackIds: ['own-audio'] }),
    };
    media.push(rtc);
    config.signal.addEventListener('abort', () => rtc.close(), { once: true });
    config.onLocalStream(stream);
    if (options.captureGate) await options.captureGate.promise;
    return rtc;
  };
  const { CallsProvider } = load('src/calls/CallsProvider.js', {
    react, 'react-native': { AppState, Platform: { OS: options.os || 'android' } },
    'expo-crypto': { randomUUID: () => `device-${++sequence}` },
    '../core/api': { __esModule: true, default: api, getAccessToken: async () => 'mock-token', getWsBaseUrl: async () => 'ws://localhost:8030' },
    '../core/global': useGlobal,
    './rtcSession': { createRtcSession, getCallAvailability: () => ({ available: true, reason: null }) },
    './callNativeSession': {
      getCallNativeAvailability: () => ({ available: Boolean(options.nativeAvailable), reason: null }),
      startCallNativeSession: async (config) => {
        const lease = { config, stops: 0, closed: false,
          update: async () => true,
          stop() { if (!this.closed) { this.closed = true; this.stops += 1; } },
          selectAudioRoute: async () => ({ routes: [], selectedRouteId: null }) };
        config.signal.addEventListener('abort', () => lease.stop(), { once: true });
        nativeSessions.push(lease);
        return lease;
      },
    },
    './callClient': { createCallClient(config) {
      client = adapter.createCallClient(config);
      for (const name of ['activate', 'deactivate', 'setForeground']) {
        const original = client[name];
        client[name] = (...args) => { events.push(`${name}:${args[0] ?? ''}`); return original(...args); };
      }
      const subscribe = client.subscribe;
      client.subscribe = (listener) => {
        clientListeners.add(listener);
        const unsubscribe = subscribe(listener);
        return () => { clientListeners.delete(listener); unsubscribe(); };
      };
      return client;
    } },
  }, {
    WebSocket: Socket, document,
    addEventListener: (name, callback) => register(windowListeners, name, callback),
    removeEventListener: (name, callback) => windowListeners.get(name)?.delete(callback),
  });
  function render() {
    assert.equal(unmounted, false);
    cursor = 0; pendingEffects = []; renderCount += 1;
    const tree = CallsProvider({ children: 'chat' });
    pendingEffects.forEach((effect) => effect());
    return tree;
  }
  render();
  return {
    client, events, sockets, captures, media, nativeSessions, timers, storeListeners, appListeners, clientListeners,
    documentListeners, windowListeners, render,
    get renders() { return renderCount; },
    async connect() { await settle(); sockets.at(-1)?.open(); await settle(); },
    session(next) {
      const previous = store; store = { ...store, ...next };
      storeListeners.forEach((listener) => listener(store, previous));
    },
    appState(next) { AppState.currentState = next; appListeners.forEach((listener) => listener(next)); },
    visibility(next) { document.visibilityState = next; documentListeners.get('visibilitychange')?.forEach((listener) => listener()); },
    pagehide() { windowListeners.get('pagehide')?.forEach((listener) => listener()); },
    unmount() { unmounted = true; slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('synchronous logout and login of the same account close old RTC and socket before any React render', async () => {
  const h = harness(); await h.connect();
  await h.client.startCall(1, 'audio', { username: 'bob' });
  const oldSocket = h.sockets[0];
  const before = h.renders; const eventStart = h.events.length;
  h.session({ authenticated: false, user: null });
  assert.equal(h.captures[0].signal.aborted, true);
  assert.equal(h.media[0].closes, 1);
  assert.equal(h.media[0].audio.stops, 1);
  assert.equal(oldSocket.readyState, 3);
  assert.equal(h.client.getState().call, null);
  h.session({ authenticated: true, user: { username: 'alice' } });
  assert.equal(h.renders, before);
  const events = h.events.slice(eventStart);
  assert(events.indexOf('deactivate:') < events.indexOf('activate:alice'));
  assert(events.indexOf('rtc:closed') < events.indexOf('activate:alice'));
  await h.connect();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.captures.length, 1);
  h.render();
  assert.equal(h.storeListeners.size, 1);
  assert.equal(h.clientListeners.size, 1);
  h.unmount();
});

test('logout invalidates a pending capture and its late result cannot invite or reopen the same account', async () => {
  const gate = deferred(); const h = harness({ captureGate: gate }); await h.connect();
  const pending = h.client.startCall(1, 'audio', { username: 'bob' }); await settle();
  assert.equal(h.captures.length, 1);
  h.session({ authenticated: false, user: null });
  h.session({ authenticated: true, user: { username: 'alice' } });
  assert.equal(h.captures[0].signal.aborted, true);
  assert.equal(h.media[0].audio.readyState, 'ended');
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.client.getState().call, null);
  assert.equal(h.media[0].closes, 1);
  h.unmount();
});

test('native inactive and background events close media immediately and foreground never starts capture automatically', async () => {
  for (const state of ['inactive', 'background']) {
    const h = harness(); await h.connect();
    await h.client.startCall(1, 'audio', { username: 'bob' });
    const renderCount = h.renders;
    h.appState(state);
    assert.equal(h.renders, renderCount);
    assert.equal(h.captures[0].signal.aborted, true);
    assert.equal(h.media[0].closes, 1);
    assert.equal(h.sockets[0].readyState, 3);
    assert.equal(h.client.getState().call, null);
    h.appState('active'); await h.connect();
    assert.equal(h.captures.length, 1);
    assert.equal(h.sockets.length, 2);
    h.unmount();
  }
});

test('an initially backgrounded provider does not open a socket or capture until foreground and a user action', async () => {
  const h = harness({ initialAppState: 'background' }); await settle();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.captures.length, 0);
  assert.equal(await h.client.startCall(1, 'audio', { username: 'bob' }), false);
  h.appState('active'); await h.connect();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.captures.length, 0);
  h.unmount();
});

test('web visibility and page exit close media while visibility restoration only reconnects signaling', async () => {
  for (const event of ['visibility', 'pagehide']) {
    const h = harness({ os: 'web' }); await h.connect();
    await h.client.startCall(1, 'video', { username: 'bob' });
    if (event === 'visibility') h.visibility('hidden'); else h.pagehide();
    assert.equal(h.media[0].closes, 1);
    assert.equal(h.captures[0].signal.aborted, true);
    assert.equal(h.sockets[0].readyState, 3);
    h.visibility('visible'); await h.connect();
    assert.equal(h.captures.length, 1);
    assert.equal(h.sockets.length, 2);
    h.unmount();
  }
});

test('unmount releases RTC and unsubscribes store, client, AppState and web handlers before future events', async () => {
  for (const os of ['android', 'web']) {
    const h = harness({ os }); await h.connect();
    await h.client.startCall(1, 'audio', { username: 'bob' });
    assert.equal(h.storeListeners.size, 1);
    assert.equal(h.appListeners.size, 1);
    assert.equal(h.clientListeners.size, 1);
    h.unmount();
    assert.equal(h.media[0].closes, 1);
    assert.equal(h.storeListeners.size, 0);
    assert.equal(h.appListeners.size, 0);
    assert.equal(h.clientListeners.size, 0);
    assert.equal(h.documentListeners.get('visibilitychange')?.size || 0, 0);
    assert.equal(h.windowListeners.get('pagehide')?.size || 0, 0);
    assert.equal(h.timers.size, 0);
    const events = h.events.length; const sockets = h.sockets.length;
    h.session({ authenticated: false, user: null });
    h.session({ authenticated: true, user: { username: 'alice' } });
    h.appState('background'); h.appState('active'); h.visibility('hidden'); h.pagehide();
    await settle();
    assert.equal(h.events.length, events);
    assert.equal(h.sockets.length, sockets);
  }
});

test('an unrelated store update does not reactivate the account or replace its live call socket', async () => {
  const h = harness(); await h.connect();
  await h.client.startCall(1, 'audio', { username: 'bob' });
  const count = h.events.length;
  h.session({ pendingMessages: [], user: { username: 'alice', name: 'Updated name' } });
  assert.equal(h.events.length, count);
  assert.equal(h.captures[0].signal.aborted, false);
  assert.equal(h.media[0].closes, 0);
  assert.equal(h.sockets.length, 1);
  h.unmount();
});

test('native foreground ownership keeps the started call alive through background and stops synchronously on logout', async () => {
  const h = harness({ nativeAvailable: true }); await h.connect();
  await h.client.startCall(1, 'audio', { username: 'bob' });
  assert.equal(h.nativeSessions.length, 1);
  const socket = h.sockets[0];
  h.appState('background'); await settle();
  assert.equal(socket.readyState, 1);
  assert.equal(h.captures[0].signal.aborted, false);
  assert.equal(h.media[0].audio.readyState, 'live');
  h.appState('active'); await settle();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.captures.length, 1);
  h.appState('background');
  h.session({ authenticated: false, user: null });
  assert.equal(h.captures[0].signal.aborted, true);
  assert.equal(h.media[0].closes, 1);
  assert.equal(h.nativeSessions[0].stops, 1);
  assert.equal(socket.readyState, 3);
  h.unmount();
});
