const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');
const axios = require('axios');
const { randomUUID } = require('node:crypto');
const compiledModules = new Map();

function loadModule(name, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, '../src/core', name);
  let code = compiledModules.get(filename);
  if (!code) {
    ({ code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [require('@babel/plugin-transform-modules-commonjs')],
    }));
    compiledModules.set(filename, code);
  }
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require(id) {
      if (id in mocks) return mocks[id];
      if (id === './messages') return loadModule('messages.js');
      if (id === './typing') return loadModule('typing.js', mocks, globals);
      if (id === './outbox') return loadModule('outbox.js', mocks, globals);
      throw new Error(`Unexpected dependency: ${id}`);
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
    FormData,
    atob,
    AbortController,
    ...globals,
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
    async wipe() { values.clear(); },
  };
}

function coreHarness(options = {}) {
  const secure = options.secure || storage();
  const asyncStorage = options.asyncStorage || {
    values: new Map(),
    async getItem(key) { return this.values.get(key) || null; },
    async setItem(key, value) { this.values.set(key, value); },
  };
  const sockets = [];
  const timers = new Map();
  const alerts = [];
  const errorLogs = [];
  let timerSequence = 0;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(payload) { options.onSocketSend?.(JSON.parse(payload)); this.sent.push(JSON.parse(payload)); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
    receive(source, data) { this.onmessage?.({ data: JSON.stringify({ source, data }) }); }
  }
  let expirationHandler;
  const exported = loadModule('global.js', {
    'react-native': { AppState: options.appState || { currentState: 'active' }, Platform: { OS: 'android' }, Alert: { alert: (...args) => alerts.push(args) } },
    '@react-native-async-storage/async-storage': asyncStorage,
    'expo-crypto': { randomUUID },
    zustand: {
      create(initializer) {
        let state;
        const get = () => state;
        const set = (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; };
        state = initializer(set, get);
        return { getState: get, setState: set };
      },
    },
    './api': {
      __esModule: true,
      default: { get: options.getProfile || (async () => ({ data: { user: { username: 'me' } } })),
        post: options.uploadAvatar || (async () => { throw new Error('Unexpected POST'); }),
        patch: options.patchProfile || (async () => { throw new Error('Unexpected PATCH'); }),
        delete: options.deleteConversation || (async () => { throw new Error('Unexpected DELETE'); }) },
      getAccessToken: options.getAccessToken || (async () => (await secure.get('tokens'))?.access),
      getWsBaseUrl: async () => 'ws://localhost:8000',
      resetAuthSession() {},
      setSessionExpiredHandler(handler) { expirationHandler = handler; },
    },
    './secure': secure,
    './utils': Object.fromEntries(['getAudio', 'getDocument', 'getImage', 'getVideo'].map((name) => [name, (uri) => ({ uri: uri.startsWith('http') ? uri : `http://localhost:8000${uri}` })])),
  }, {
    WebSocket: Socket,
    console: { log() {}, warn() {}, error: (...args) => errorLogs.push(args) },
    setTimeout(callback, delay) { timers.set(++timerSequence, { callback, delay }); return timerSequence; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { store: exported.default, secure, asyncStorage, sockets, timers, alerts, errorLogs, expire: () => expirationHandler() };
}

async function connectedHarness(options) {
  const harness = coreHarness(options);
  await harness.store.getState().login({ username: 'me', password: 'never-save' }, { username: 'me' }, { access: 'access', refresh: 'refresh' });
  await harness.store.getState().socketConnect();
  const socket = harness.sockets[0];
  socket.open();
  socket.receive('friend.list', [
    { id: 1, friend: { username: 'alice' }, unreadCount: 0 },
    { id: 2, friend: { username: 'bob' }, unreadCount: 0 },
  ]);
  return { ...harness, socket };
}

test('profile photo upload uses authenticated HTTP and confirms without a chat socket', async () => {
  const selected = { selected: 'photo-form-data' };
  const h = coreHarness({ uploadAvatar: async (url, body) => {
    assert.equal(url, '/chat/me/avatar/');
    assert.equal(body, selected);
    return { data: { user: { username: 'me', miniatura: '/media/miniatura/new.jpg' } } };
  } });
  await h.store.getState().login({ username: 'me' }, { username: 'me' }, { access: 'access', refresh: 'refresh' });
  assert.equal(h.sockets.length, 0);
  assert.equal(await h.store.getState().uploadMiniatura(selected), true);
  assert.equal(h.store.getState().user.miniatura, '/media/miniatura/new.jpg');
});

test('a profile photo response after logout cannot restore the old account', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = coreHarness({ uploadAvatar: () => pending });
  await h.store.getState().login({ username: 'me' }, { username: 'me' }, { access: 'access', refresh: 'refresh' });
  const upload = h.store.getState().uploadMiniatura({ selected: 'photo' });
  await h.store.getState().logout();
  resolve({ data: { user: { username: 'me', miniatura: '/media/miniatura/stale.jpg' } } });
  await assert.rejects(upload, error => error.code === 'SESSION_CHANGED');
  assert.equal(h.store.getState().authenticated, false);
  assert.equal(h.store.getState().user?.miniatura, undefined);
  assert.equal(h.store.getState().user?.username, undefined);
});

function message(id, text = 'hello', isMe = false) {
  const created = new Date(Date.UTC(2026, 9, 6, 12) + Number(id) * 1000).toISOString();
  return { id, text, type: 'text', is_me: isMe, isNew: true, created };
}

function payload(id, friend = 'alice', isMe = false) {
  return { friend: { username: friend }, message: message(id, 'hello', isMe) };
}

function mediaPayload(id, type, isMe = false, friend = 'alice') {
  const extensions = { image: 'jpg', audio: 'm4a', video: 'mp4', document: 'pdf' };
  return {
    friend: { username: friend },
    message: {
      ...message(id, '', isMe),
      type,
      [type]: `/media/${type}-${id}.${extensions[type]}`,
    },
  };
}

test('typing routes by conversation and exact contact identity and rejects cleared or expired events', async () => {
  const { store, socket, timers } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const typing = { connectionId: 1, username: 'alice', isTyping: true, revision: 0 };
  for (const event of [
    { ...typing, connectionId: 2 }, { ...typing, username: 'Alice' },
    { ...typing, revision: 1 }, { ...typing, isTyping: 'false' },
    { ...typing, expiresAt: new Date(Date.now() - 1000).toISOString() },
    { ...typing, expiresAt: 'invalid' },
  ]) {
    socket.receive('message.type', event);
    assert.equal(store.getState().messagesTyping, null);
    assert.equal(timers.size, 0);
  }
  socket.receive('message.type', typing);
  assert.equal(store.getState().messagesTyping.username, 'alice');
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal([...timers.values()][0].delay, 5000);
  socket.receive('message_history_cleared', { connectionId: 1, revision: 1, clearedThrough: 0 });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', typing);
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', { ...typing, revision: 1 });
  assert.ok(store.getState().messagesTyping);
});

test('typing heartbeat replaces its expiry and old timers cannot hide a newer indicator', async () => {
  const { store, socket, timers } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const event = { connectionId: 1, username: 'alice', isTyping: true, revision: 0 };
  socket.receive('message.type', event);
  const oldExpiry = [...timers.values()][0].callback;
  const first = store.getState().messagesTyping;
  socket.receive('message.type', { ...event, expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 5000);
  const current = store.getState().messagesTyping;
  assert.notEqual(current, first);
  oldExpiry();
  assert.equal(store.getState().messagesTyping, current);
  socket.receive('message.type', { ...event, isTyping: false, expiresAt: null });
  assert.equal(store.getState().messagesTyping, null);
  assert.equal(timers.size, 0);
  socket.receive('message.type', event);
  [...timers.values()][0].callback();
  assert.equal(store.getState().messagesTyping, null);
  assert.equal(timers.size, 0);
});

test('own acknowledgments preserve peer typing and peer messages or connection changes clear it', async () => {
  const { store, socket, sockets, timers } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const event = { connectionId: 1, username: 'alice', isTyping: true, revision: 0 };
  socket.receive('message.type', event);
  socket.receive('message.send', { ...payload(40, 'alice', true), connectionId: 1 });
  assert.ok(store.getState().messagesTyping);
  socket.receive('message.send', { ...payload(41), connectionId: 1 });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', event);
  const staleExpiry = [...timers.values()][0].callback;
  store.getState().openMessagesThread('bob', 2);
  assert.equal(store.getState().messagesTyping, null);
  assert.equal(timers.size, 0);
  socket.receive('message.type', event);
  assert.equal(store.getState().messagesTyping, null);
  store.getState().openMessagesThread('alice', 1);
  socket.receive('message.type', event);
  socket.close();
  assert.equal(store.getState().messagesTyping, null);
  await store.getState().socketConnect();
  sockets[1].open();
  sockets[1].receive('message.type', event);
  const replacement = store.getState().messagesTyping;
  staleExpiry();
  assert.equal(store.getState().messagesTyping, replacement);
  await store.getState().logout();
  staleExpiry();
  assert.equal(store.getState().messagesTyping, null);
  assert.equal(timers.size, 0);
});

test('typing sends explicit start and stop with the current revision only for the focused signed-in conversation', async () => {
  const appState = { currentState: 'active' };
  const { store, socket } = await connectedHarness({ appState });
  store.getState().openMessagesThread('alice', 1);
  store.setState({ conversationHistory: { 1: { revision: 3 } } });
  assert.equal(store.getState().messageType(2, true), false);
  assert.equal(store.getState().messageType(1, true), true);
  assert.deepEqual(socket.sent.at(-1), { source: 'message.type', connectionId: 1, isTyping: true, historyRevision: 3,
    clientSequence: 1, draft: null, draftRevision: 0 });
  appState.currentState = 'background';
  assert.equal(store.getState().messageType(1, true), false);
  assert.equal(store.getState().messageType(1, false), true);
  assert.equal(socket.sent.at(-1).isTyping, false);
  appState.currentState = 'active';
  store.setState({ conversationClearing: { 1: true } });
  assert.equal(store.getState().messageType(1, true), false);
  store.getState().clearMessages();
  assert.equal(store.getState().messageType(1, false), false);
  await store.getState().logout();
  assert.equal(store.getState().messageType(1, true), false);
});

test('draft content is opt-in, requires a verified identity and never enters messages, outbox or saved profile', async () => {
  const { store, socket, secure, asyncStorage } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const draft = 'Unsent private draft';
  store.getState().messageType(1, true, draft);
  assert.equal(socket.sent.at(-1).draft, null);
  store.setState({ user: { ...store.getState().user, liveTypingEnabled: true, liveTypingRevision: 2 }, outboxIdentityVerified: false });
  store.getState().messageType(1, true, draft);
  assert.equal(socket.sent.at(-1).draft, null);
  store.setState({ outboxIdentityVerified: true });
  store.getState().messageType(1, true, '😀'.repeat(600));
  assert.equal(Array.from(socket.sent.at(-1).draft).length, 500);
  assert.equal(Buffer.byteLength(socket.sent.at(-1).draft), 2000);
  assert.equal(socket.sent.at(-1).draftRevision, 2);
  assert.equal(socket.sent.at(-1).clientSequence, 3);
  store.setState({ liveTypingUpdating: true });
  store.getState().messageType(1, true, draft);
  assert.equal(socket.sent.at(-1).draft, null);
  store.getState().messageType(1, false, draft);
  assert.equal(socket.sent.at(-1).draft, null);
  assert.equal(socket.sent.at(-1).clientSequence, 5);
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(JSON.stringify([...secure.values, ...asyncStorage.values]).includes(draft), false);
});

test('ordered draft events cannot resurrect content after stop, newer privacy revision, expiry or shared deletion', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const base = { connectionId: 1, username: 'alice', isTyping: true, revision: 0, streamId: 'server-stream',
    sequence: 1, draftRevision: 2, draft: 'Unsent', expiresAt: new Date(Date.now() + 5000).toISOString() };
  socket.receive('message.type', base);
  assert.equal(store.getState().messagesTyping.draft, 'Unsent');
  socket.receive('message.type', { ...base, sequence: 4, isTyping: false, draft: null, expiresAt: null });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', { ...base, sequence: 3 });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', { ...base, sequence: 5, draftRevision: 1 });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', { ...base, streamId: 'new-stream', sequence: 6, draftRevision: 3, draft: 'New draft' });
  assert.equal(store.getState().messagesTyping.draft, 'New draft');
  socket.receive('message.type', { ...base, sequence: 5, isTyping: false });
  assert.equal(store.getState().messagesTyping.draft, 'New draft');
  socket.receive('message.type', { ...base, sequence: 7, draftRevision: 4, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', { ...base, sequence: 6, draftRevision: 4 });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', { ...base, sequence: 8, draftRevision: 4 });
  assert.ok(store.getState().messagesTyping);
  socket.receive('message_history_cleared', { connectionId: 1, revision: 1, clearedThrough: 0 });
  socket.receive('message.type', { ...base, sequence: 9, draftRevision: 4 });
  assert.equal(store.getState().messagesTyping, null);
  store.setState({ outboxIdentityVerified: false });
  socket.receive('message.type', { ...base, revision: 1, sequence: 10 });
  assert.equal(store.getState().messagesTyping.draft, null, 'cached account identity cannot reveal draft content');
  const staleCallback = socket.onmessage;
  await store.getState().logout();
  staleCallback({ data: JSON.stringify({ source: 'message.type', data: { ...base, sequence: 11 } }) });
  assert.equal(store.getState().messagesTyping, null);
});

test('legacy typing never reveals a draft and invalid ordering cannot overwrite an ordered activity', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const base = { connectionId: 1, username: 'alice', isTyping: true, revision: 0, draft: 'Injected legacy text' };
  socket.receive('message.type', base);
  assert.equal(store.getState().messagesTyping.draft, null);
  socket.receive('message.type', { ...base, sequence: 10, streamId: 'server', draftRevision: 0, draft: 'Actual draft' });
  socket.receive('message.type', { ...base, isTyping: false });
  assert.equal(store.getState().messagesTyping.draft, 'Actual draft');
});

test('a stop from an older sender device cannot erase another device activity and privacy-off stops clear all devices', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const base = { connectionId: 1, username: 'alice', isTyping: true, revision: 0, draftRevision: 1, draft: 'Other device' };
  socket.receive('message.type', { ...base, streamId: 'device-one', sequence: 1 });
  socket.receive('message.type', { ...base, streamId: 'device-two', sequence: 2 });
  socket.receive('message.type', { ...base, streamId: 'device-one', sequence: 3, isTyping: false, draft: null });
  assert.equal(store.getState().messagesTyping.streamId, 'device-two');
  socket.receive('message.type', { ...base, streamId: 'privacy-stop', sequence: 4, draftRevision: 2, isTyping: false, draft: null });
  assert.equal(store.getState().messagesTyping, null);
  socket.receive('message.type', { ...base, streamId: 'device-two', sequence: 5 });
  assert.equal(store.getState().messagesTyping, null);
});

test('saving a different profile field cannot restore an older sharing preference', async () => {
  const patch = deferred();
  const { store, socket, secure } = await connectedHarness({ patchProfile: () => patch.promise });
  const saving = store.getState().updateEmail('owner@example.test', 'password');
  socket.receive('typing.settings', { liveTypingEnabled: false, liveTypingRevision: 3 });
  patch.resolve({ data: { user: { username: 'me', email: 'owner@example.test', liveTypingEnabled: true, liveTypingRevision: 2 } } });
  await saving;
  assert.equal(store.getState().user.liveTypingRevision, 3);
  assert.equal(store.getState().user.liveTypingEnabled, false);
  assert.equal((await secure.get('user')).liveTypingEnabled, false);
});

test('server settings and late profile responses preserve the newest private preference revision', async () => {
  const patch = deferred();
  const requests = [];
  const { store, socket, secure } = await connectedHarness({ patchProfile: async (url, body) => { requests.push({ url, body }); return patch.promise; } });
  store.getState().openMessagesThread('alice', 1);
  const saving = store.getState().updateLiveTyping(true);
  assert.equal(store.getState().liveTypingUpdating, true);
  assert.equal(socket.sent.at(-1).isTyping, false);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ url: '/chat/me/', body: { liveTypingEnabled: true } }]);
  socket.receive('typing.settings', { liveTypingEnabled: false, liveTypingRevision: 4 });
  socket.receive('typing.settings', { liveTypingEnabled: true, liveTypingRevision: 2 });
  patch.resolve({ data: { user: { username: 'me', liveTypingEnabled: true, liveTypingRevision: 3 } } });
  await saving;
  assert.equal(store.getState().user.liveTypingEnabled, false);
  assert.equal(store.getState().user.liveTypingRevision, 4);
  assert.equal((await secure.get('user')).liveTypingRevision, 4);
  assert.equal(store.getState().liveTypingUpdating, false);
});

test('failed preference saves are retryable and a response from the previous login cannot enable sharing', async () => {
  const patch = deferred();
  let attempt = 0;
  const { store, secure } = await connectedHarness({ patchProfile: async () => {
    if (++attempt === 1) throw new Error('network');
    return patch.promise;
  } });
  await assert.rejects(store.getState().updateLiveTyping(true), /network/);
  assert.equal(store.getState().user.liveTypingEnabled, false);
  assert.equal(store.getState().liveTypingUpdating, false);
  const saving = store.getState().updateLiveTyping(true);
  const rejected = assert.rejects(saving, /sesión cambió/);
  await store.getState().logout();
  await store.getState().login({}, { username: 'me' }, { access: 'new', refresh: 'new-refresh' });
  patch.resolve({ data: { user: { username: 'me', liveTypingEnabled: true, liveTypingRevision: 2 } } });
  await rejected;
  assert.equal(store.getState().user.liveTypingEnabled, false);
  assert.equal((await secure.get('user')).liveTypingEnabled, false);
  assert.equal(store.getState().liveTypingUpdating, false);
});

test('reconnection retrieves a preference changed on another device and rejects the replaced socket settings', async () => {
  const { store, socket, sockets } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  socket.receive('typing.settings', { liveTypingEnabled: true, liveTypingRevision: 1 });
  const oldMessage = socket.onmessage;
  socket.close();
  await store.getState().socketConnect();
  const replacement = sockets[1]; replacement.open();
  assert.equal(replacement.sent.filter((message) => message.source === 'typing.settings').length, 1);
  replacement.receive('typing.settings', { liveTypingEnabled: false, liveTypingRevision: 2 });
  oldMessage({ data: JSON.stringify({ source: 'typing.settings', data: { liveTypingEnabled: true, liveTypingRevision: 3 } }) });
  assert.equal(store.getState().user.liveTypingEnabled, false);
  assert.equal(store.getState().user.liveTypingRevision, 2);
  store.getState().messageType(1, true, 'Private after reconnect');
  assert.equal(replacement.sent.at(-1).draft, null);
  assert.equal(replacement.sent.at(-1).clientSequence, 2, 'settings synchronization sends its own stop before the next activity');
});

function historyResponse(store, messages, overrides = {}) {
  return {
    connectionId: store.getState().messagesConnectionId,
    page: 0,
    requestId: store.getState().messagesRequestId,
    friend: { username: store.getState().messagesUsername },
    messages,
    ...overrides,
  };
}

test('history merge deduplicates string/numeric ids and preserves chronological order', () => {
  const { mergeMessages } = loadModule('messages.js');
  const merged = mergeMessages([message(2), message(1)], [{ ...message(2), id: '2', text: 'updated' }, message(3)]);
  assert.deepEqual(Array.from(merged, (item) => String(item.id)), ['3', '2', '1']);
  assert.equal(merged[1].text, 'updated');
});

test('a delayed message echo cannot reverse a confirmed read receipt', () => {
  const { mergeMessages } = loadModule('messages.js');
  const merged = mergeMessages([{ ...message(2), isNew: false }], [message(2)]);
  assert.equal(merged[0].isNew, false);
});

test('login stores tokens and profile without storing the password', async () => {
  const { store, secure } = await connectedHarness();
  assert.equal(store.getState().authenticated, true);
  assert.equal(secure.values.has('credentials'), false);
  assert.equal(secure.values.get('user').username, 'me');
});

test('updating own email preserves password whitespace and persists only the private returned profile', async () => {
  let request;
  const { store, secure } = await connectedHarness({ patchProfile: async (url, body) => {
    request = { url, body }; return { data: { user: { username: 'me', email: 'new@example.com', authVersion: 2 } } };
  } });
  const user = await store.getState().updateEmail(' new@example.com ', '  exact password  ');
  assert.equal(request.url, '/chat/me/');
  assert.equal(request.body.email, 'new@example.com');
  assert.equal(request.body.current_password, '  exact password  ');
  assert.equal(user.email, 'new@example.com');
  assert.equal(store.getState().user.authVersion, 2);
  assert.equal(secure.values.get('user').email, 'new@example.com');
  assert.equal(secure.values.get('user').current_password, undefined);
});

test('a delayed email response cannot update a new login of the same account or persist the old email', async () => {
  const gate = deferred();
  const { store, secure } = await connectedHarness({ patchProfile: () => gate.promise });
  const snapshot = store.getState().captureAuthSession();
  const changing = store.getState().updateEmail('old-request@example.com', 'password');
  const rejected = assert.rejects(changing, { code: 'SESSION_CHANGED' });
  await store.getState().logout();
  await store.getState().login(null, { username: 'me', email: 'new-session@example.com' }, { access: 'new', refresh: 'new-refresh' });
  assert.equal(store.getState().isAuthSessionCurrent(snapshot), false);
  gate.resolve({ data: { user: { username: 'me', email: 'old-request@example.com' } } });
  await rejected;
  assert.equal(store.getState().user.email, 'new-session@example.com');
  assert.equal(secure.values.get('user').email, 'new-session@example.com');
});

test('password reset signs out only the targeted exact account and captured login session', async () => {
  const { store, socket, secure } = await connectedHarness();
  const first = store.getState().captureAuthSession();
  assert.equal(await store.getState().completePasswordReset('Me', first), false);
  await store.getState().logout();
  await store.getState().login(null, { username: 'me' }, { access: 'new', refresh: 'new-refresh' });
  assert.equal(await store.getState().completePasswordReset('me', first), false);
  assert.equal(store.getState().authenticated, true);
  const current = store.getState().captureAuthSession();
  const ending = store.getState().completePasswordReset('me', current);
  assert.equal(store.getState().authenticated, false);
  assert.equal(await ending, true);
  assert.equal(socket.readyState, 3);
  assert.equal(secure.values.size, 0);
});

test('auth invalidation closes revoked chat sessions and ignores another account, old versions and old socket callbacks', async () => {
  const { store, socket, sockets, timers } = await connectedHarness();
  store.setState({ user: { username: 'me', authVersion: 2 } });
  assert.equal(await store.getState().invalidateAuthSession(3, 'Me'), false);
  for (const authVersion of [1, 2, '3', null]) socket.receive('auth.invalidated', { authVersion });
  assert.equal(store.getState().authenticated, true);
  const oldCallback = socket.onmessage;
  socket.receive('auth.invalidated', { authVersion: 3 });
  assert.equal(store.getState().authenticated, false);
  await settle();
  assert.equal(timers.size, 0);
  await store.getState().login(null, { username: 'me', authVersion: 3 }, { access: 'new', refresh: 'new-refresh' });
  await store.getState().socketConnect(); sockets[1].open();
  oldCallback({ data: JSON.stringify({ source: 'auth.invalidated', data: { authVersion: 4 } }) });
  sockets[1].receive('auth.invalidated', { authVersion: 3 });
  assert.equal(store.getState().authenticated, true);
});

test('saved session remains available when profile validation fails offline', async () => {
  const secure = storage({ tokens: { access: 'access', refresh: 'refresh' }, user: { username: 'me' }, credentials: { password: 'legacy-password' } });
  const { store } = coreHarness({ secure, getProfile: async () => { throw new Error('offline'); } });
  await store.getState().init();
  assert.equal(store.getState().authenticated, true);
  assert.equal(store.getState().initialized, true);
  assert.equal(secure.values.has('credentials'), false);
  assert.equal(secure.values.has('tokens'), true);
});

test('logout during initialization prevents a delayed response restoring the account', async () => {
  const pending = deferred();
  const secure = storage({ tokens: { access: 'access' }, user: { username: 'me' } });
  const { store } = coreHarness({ secure, getProfile: () => pending.promise });
  const initializing = store.getState().init();
  await new Promise((resolve) => setImmediate(resolve));
  await store.getState().logout();
  pending.resolve({ data: { user: { username: 'me' } } });
  await initializing;
  assert.equal(store.getState().authenticated, false);
  assert.equal(secure.values.size, 0);
});

test('concurrent socket connection attempts create one connection', async () => {
  const pending = deferred();
  const { store, sockets } = coreHarness({ getAccessToken: () => pending.promise });
  store.setState({ authenticated: true, user: { username: 'me' } });
  const first = store.getState().socketConnect();
  const second = store.getState().socketConnect();
  assert.equal(first, second);
  pending.resolve('access');
  await first;
  assert.equal(sockets.length, 1);
});

test('logout cancels a connection waiting for tokens', async () => {
  const pending = deferred();
  const { store, sockets, timers } = coreHarness({ getAccessToken: () => pending.promise });
  store.setState({ authenticated: true, user: { username: 'me' } });
  const connecting = store.getState().socketConnect();
  await store.getState().logout();
  pending.resolve('access');
  await connecting;
  assert.equal(sockets.length, 0);
  assert.equal(timers.size, 0);
});

test('stale socket callbacks cannot disconnect a replacement connection', async () => {
  const { store, socket, sockets } = await connectedHarness();
  const staleError = socket.onerror;
  store.getState().socketClose();
  await store.getState().socketConnect();
  sockets[1].open();
  staleError();
  assert.equal(store.getState().socket, sockets[1]);
  assert.equal(store.getState().socketConnected, true);
});

test('logout cancels scheduled reconnection and a captured timer remains harmless', async () => {
  const { store, socket, sockets, timers } = await connectedHarness();
  socket.close();
  assert.equal(timers.size, 1);
  const reconnect = [...timers.values()][0].callback;
  await store.getState().logout();
  reconnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0);
  assert.equal(sockets.length, 1);
});

test('HTTP and WebSocket echoes display one media message and do not double unread counts', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const media = { friend: { username: 'alice' }, message: { ...message(3, '', true), type: 'image', image: '/media/image.jpg' } };
  store.getState().ingestMessagePayload(media);
  socket.receive('message.send', media);
  assert.equal(store.getState().messagesList.length, 1);
  assert.equal(store.getState().messagesList[0].image, 'http://localhost:8000/media/image.jpg');
  assert.equal(store.getState().friendList[0].unreadCount, 0);
  socket.receive('message.send', payload(4, 'bob'));
  store.getState().ingestMessagePayload(payload(4, 'bob'));
  assert.equal(store.getState().friendList.find((item) => item.id === 2).unreadCount, 1);
  assert.equal(store.getState().messagesList.length, 1);
});

test('messages only update the exact matching friend username', async () => {
  const { store, socket } = await connectedHarness();
  socket.receive('friend.list', [{ id: 1, friend: { username: 'anna' }, unreadCount: 0 }]);
  socket.receive('message.send', payload(5, 'ann'));
  assert.equal(store.getState().friendList[0].unreadCount, 0);
});

test('history keeps the latest 50 by timestamp across both directions and ignores another thread', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  assert.equal(store.getState().messageList(1), true);
  assert.equal(store.getState().messageList(1), false);
  assert.equal(store.getState().messagesUsername, 'alice');
  socket.receive('message.list', historyResponse(store, [message(200)], { connectionId: 2, friend: { username: 'bob' } }));
  assert.equal(store.getState().messagesLoading, true);
  assert.equal(store.getState().messagesList.length, 0);
  const history = Array.from({ length: 75 }, (_, index) => ({
    ...message(1000 - index, 'hello', index % 2 === 0),
    created: message(index + 1).created,
  }));
  socket.receive('message.list', historyResponse(store, [...history, { ...history[74], id: String(history[74].id) }], { next: 1 }));
  assert.equal(store.getState().messagesList.length, 50);
  assert.deepEqual(Array.from(store.getState().messagesList, (item) => String(item.id)), Array.from({ length: 50 }, (_, index) => String(926 + index)));
  assert.equal(store.getState().messagesList.filter((item) => item.is_me).length, 25);
  assert.equal(store.getState().messagesList.filter((item) => !item.is_me).length, 25);
  assert.equal(store.getState().friendList.find((item) => item.id === 1).unreadCount, 0);
  assert.ok(socket.sent.some((item) => item.source === 'message.read' && item.connectionId === 1));
});

test('live sent and received messages share one 50-message limit including all media types', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  const types = ['text', 'image', 'audio', 'video', 'document'];
  for (let id = 1; id <= 85; id += 1) {
    const type = types[id % types.length];
    const incoming = type === 'text' ? payload(id, 'alice', id % 2 === 0) : mediaPayload(id, type, id % 2 === 0);
    socket.receive('message.send', incoming);
    assert.ok(store.getState().messagesList.length <= 50, `history exceeded its limit after message ${id}`);
  }
  const latest = store.getState().messagesList;
  assert.deepEqual(Array.from(latest, (item) => item.id), Array.from({ length: 50 }, (_, index) => 85 - index));
  assert.equal(latest.filter((item) => item.is_me).length, 25);
  assert.equal(latest.filter((item) => !item.is_me).length, 25);
  assert.deepEqual([...new Set(Array.from(latest, (item) => item.type))].sort(), [...types].sort());
  assert.equal(store.getState().friendList.find((item) => item.id === 1).unreadCount, 0);
});

test('HTTP media uploads and WebSocket echoes trim once without removing extra messages', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  socket.receive('message.list', historyResponse(store, Array.from({ length: 50 }, (_, index) => message(51 + index))));
  const media = [
    mediaPayload(101, 'image', true),
    mediaPayload(102, 'audio'),
    mediaPayload(103, 'video', true),
    mediaPayload(104, 'document', true),
  ];
  for (const [index, uploaded] of media.entries()) {
    if (index % 2 === 0) {
      store.getState().ingestMessagePayload(uploaded);
      socket.receive('message.send', { ...uploaded, message: { ...uploaded.message, id: String(uploaded.message.id) } });
    } else {
      socket.receive('message.send', uploaded);
      store.getState().ingestMessagePayload(uploaded);
    }
    assert.equal(store.getState().messagesList.length, 50);
  }
  const latest = store.getState().messagesList;
  assert.deepEqual(Array.from(latest, (item) => Number(item.id)), Array.from({ length: 50 }, (_, index) => 104 - index));
  for (const uploaded of media) {
    const displayed = latest.find((item) => Number(item.id) === uploaded.message.id);
    assert.equal(displayed[displayed.type], `http://localhost:8000${uploaded.message[displayed.type]}`);
  }
  assert.equal(store.getState().friendList.find((item) => item.id === 1).unreadCount, 0);
});

test('reconnection merges live arrivals with a delayed snapshot while keeping only the latest 50', async () => {
  const { store, socket, sockets } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  const snapshot = historyResponse(store, Array.from({ length: 50 }, (_, index) => message(index + 1)));
  socket.receive('message.list', snapshot);
  socket.receive('message.read', { connectionId: 1, messageIds: [42] });
  socket.close();
  await store.getState().socketConnect();
  const reconnected = sockets[1];
  reconnected.open();
  const reconnectRequestId = store.getState().messagesRequestId;
  for (let id = 51; id <= 60; id += 1) reconnected.receive('message.send', payload(id, 'alice', id % 2 === 0));
  socket.receive('message.list', { ...snapshot, requestId: reconnectRequestId });
  assert.equal(store.getState().messagesLoading, true);
  reconnected.receive('message.list', { ...snapshot, requestId: reconnectRequestId });
  assert.deepEqual(Array.from(store.getState().messagesList, (item) => item.id), Array.from({ length: 50 }, (_, index) => 60 - index));
  assert.equal(store.getState().messagesList.find((item) => item.id === 42).isNew, false);

  store.getState().messageList(1);
  reconnected.receive('message.send', payload(61));
  reconnected.receive('message.list', { ...snapshot, requestId: reconnectRequestId });
  assert.equal(store.getState().messagesLoading, true);
  reconnected.receive('message.list', historyResponse(store, Array.from({ length: 50 }, (_, index) => message(index + 12))));
  assert.deepEqual(Array.from(store.getState().messagesList, (item) => item.id), Array.from({ length: 50 }, (_, index) => 61 - index));
  assert.equal(store.getState().messagesList.find((item) => item.id === 42).isNew, false);
});

test('legacy page-one responses cannot add older messages or consume the current history request', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  socket.receive('message.list', historyResponse(store, Array.from({ length: 50 }, (_, index) => message(index + 1)), { page: 1 }));
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(store.getState().messagesLoading, true);
  socket.receive('message.list', historyResponse(store, Array.from({ length: 50 }, (_, index) => message(index + 51))));
  const latestIds = Array.from(store.getState().messagesList, (item) => item.id);
  socket.receive('message.list', historyResponse(store, [message(200)], { page: 1 }));
  assert.deepEqual(Array.from(store.getState().messagesList, (item) => item.id), latestIds);
});

test('switching threads isolates bounded history and keeps read flags across late echoes', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  const oldResponse = historyResponse(store, Array.from({ length: 55 }, (_, index) => message(index + 1)));
  socket.receive('message.list', oldResponse);
  store.getState().clearMessages();
  store.getState().openMessagesThread('bob', 2);
  store.getState().messageList(2);
  socket.receive('message.list', oldResponse);
  socket.receive('message.send', payload(60, 'alice'));
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(store.getState().messagesLoading, true);
  socket.receive('message.send', mediaPayload(166, 'video', false, 'bob'));
  socket.receive('message.list', historyResponse(store, Array.from({ length: 65 }, (_, index) => message(index + 101, 'bob message', index % 2 === 0))));
  assert.deepEqual(Array.from(store.getState().messagesList, (item) => item.id), Array.from({ length: 50 }, (_, index) => 166 - index));
  socket.receive('message.read', { connectionId: 2, messageIds: [166, 150] });
  socket.receive('message.send', mediaPayload(166, 'video', false, 'bob'));
  socket.receive('message.list', oldResponse);
  assert.equal(store.getState().messagesList.length, 50);
  assert.equal(store.getState().messagesList.find((item) => item.id === 166).isNew, false);
  assert.equal(store.getState().messagesList.find((item) => item.id === 150).isNew, false);
  assert.equal(store.getState().friendList.find((item) => item.id === 1).unreadCount, 1);
});

test('a stale response from an earlier opening of the same thread is ignored', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  const oldRequestId = store.getState().messagesRequestId;
  store.getState().clearMessages();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  socket.receive('message.list', { connectionId: 1, page: 0, requestId: oldRequestId, friend: { username: 'alice' }, messages: [message(2)] });
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(store.getState().messagesLoading, true);
});

test('bulk read acknowledgments clear displayed unread message flags', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().ingestMessagePayload(payload(4));
  socket.receive('message.read', { connectionId: 1, messageIds: [4] });
  assert.equal(store.getState().messagesList[0].isNew, false);
});

test('sending text without a signed-in account fails without adding a local message', async () => {
  const { store } = coreHarness();
  assert.equal(await store.getState().messageSend(1, 'hello'), false);
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(store.getState().messagesList.length, 0);
});

test('socket errors preserve the server explanation stored at the envelope root', async () => {
  const { socket, alerts } = await connectedHarness();
  socket.onmessage({ data: JSON.stringify({ source: 'error', message: 'El archivo supera el limite.' }) });
  assert.equal(alerts[0][1], 'El archivo supera el limite.');
});

function durableStorage(options = {}) {
  return {
    values: options.values || new Map(),
    async getItem(key) { await options.beforeRead?.(key); return this.values.get(key) || null; },
    async setItem(key, value) { await options.beforeWrite?.(key, value); this.values.set(key, value); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const textSends = (socket) => socket.sent.filter((item) => item.source === 'message.send');
const clearedHistory = (patch = {}) => ({ connectionId: 1, revision: 1, clearedThrough: 20,
  clearedAt: '2026-10-09T18:00:00Z', ...patch });
function textAck(pending, id = 500) {
  return { connectionId: pending.connectionId, friend: { username: 'alice' },
    message: { ...message(id, pending.text, true), clientId: pending.clientId, created: pending.created } };
}

test('shared conversation deletion removes both history and old pending text while preserving contact and other conversations', async () => {
  const requests = [];
  const { store, socket, asyncStorage } = await connectedHarness({ deleteConversation: async (url, config) => {
    requests.push({ url, config }); return { data: clearedHistory() };
  } });
  store.getState().openMessagesThread('alice', 1);
  store.getState().ingestMessagePayload(payload(10));
  store.getState().ingestMessagePayload(payload(11, 'bob'));
  await store.getState().messageSend(1, 'pendiente antiguo');
  await store.getState().messageSend(2, 'conservar otro chat');
  await store.getState().clearConversation(1);
  await settle();
  assert.equal(requests[0].url, '/chat/connections/1/history/');
  assert.equal(requests[0].config.signal.aborted, false);
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(store.getState().friendList.length, 2);
  const alice = store.getState().friendList.find((row) => row.id === 1);
  assert.equal(alice.message, null);
  assert.equal(alice.unreadCount, 0);
  assert.equal(store.getState().friendList.find((row) => row.id === 2).message.id, 11);
  assert.deepEqual(Array.from(store.getState().pendingMessages, (row) => row.connectionId), [2]);
  assert.deepEqual(JSON.parse(asyncStorage.values.get('chat.outbox.v1:me')).messages.map((row) => row.connectionId), [2]);
  assert.equal(await store.getState().messageSend(1, 'mensaje nuevo'), true);
  const pending = store.getState().pendingMessages.find((row) => row.connectionId === 1);
  assert.equal(pending.historyRevision, 1);
  socket.receive('message.send', { ...textAck(pending, 21), ...clearedHistory() });
  assert.deepEqual(Array.from(store.getState().messagesList, (row) => row.id), [21]);
});

test('delayed history, message and friend snapshots cannot revive a cleared conversation', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  const oldList = historyResponse(store, [message(5)]);
  socket.receive('message_history_cleared', clearedHistory());
  socket.receive('message.list', oldList);
  socket.receive('message.send', { ...payload(5), connectionId: 1, revision: 0, clearedThrough: 0 });
  socket.receive('friend.new', { id: 1, friend: { username: 'alice' }, message: message(5), unreadCount: 7,
    revision: 0, clearedThrough: 0 });
  socket.receive('friend.list', [{ id: 1, friend: { username: 'alice' }, message: message(5), unreadCount: 7,
    revision: 0, clearedThrough: 0 }]);
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(store.getState().friendList[0].unreadCount, 0);
  assert.equal(Boolean(store.getState().friendList[0].message), false);
  socket.receive('message.list', historyResponse(store, [message(5), message(22)], clearedHistory()));
  assert.deepEqual(Array.from(store.getState().messagesList, (row) => row.id), [22]);
  assert.equal(store.getState().conversationHistory['1'].revision, 1);
});

test('reconnect waits for authoritative revisions and durably drops offline messages from before a shared deletion', async () => {
  const saved = { clientId: '88888888-8888-4888-8888-888888888888', connectionId: 1,
    text: 'antiguo sin conexión', created: message(1).created, deliveryStatus: 'pending' };
  const disk = durableStorage({ values: new Map([['chat.outbox.v1:me', JSON.stringify({ version: 1, messages: [saved] })]]) });
  const { store, sockets } = coreHarness({ asyncStorage: disk });
  await store.getState().login(null, { username: 'me' }, { access: 'access', refresh: 'refresh' });
  await store.getState().socketConnect();
  const socket = sockets[0];
  socket.open();
  assert.equal(textSends(socket).length, 0);
  socket.receive('friend.list', [{ id: 1, friend: { username: 'alice' }, ...clearedHistory() }]);
  await settle();
  assert.equal(textSends(socket).length, 0);
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(JSON.parse(disk.values.get('chat.outbox.v1:me')).messages.length, 0);
  assert.equal(await store.getState().messageSend(1, 'vigente'), true);
  assert.equal(textSends(socket)[0].historyRevision, 1);
});

test('a remote clear invalidates an enqueue whose storage write finishes late', async () => {
  const gate = deferred();
  let hold = false;
  const disk = durableStorage({ beforeWrite: async () => { if (hold) await gate.promise; } });
  const { store, socket } = await connectedHarness({ asyncStorage: disk });
  hold = true;
  const sending = store.getState().messageSend(1, 'cancelar guardado antiguo');
  await settle();
  socket.receive('message_history_cleared', clearedHistory());
  gate.resolve();
  assert.equal(await sending, false);
  await settle();
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(textSends(socket).length, 0);
  assert.equal(JSON.parse(disk.values.get('chat.outbox.v1:me')).messages.length, 0);
});

test('DELETE failure keeps history, releases controls and resumes the existing queue', async () => {
  const deleting = deferred();
  const { store, socket } = await connectedHarness({ deleteConversation: () => deleting.promise });
  store.getState().openMessagesThread('alice', 1);
  store.getState().ingestMessagePayload(payload(10));
  await store.getState().messageSend(1, 'pendiente válido');
  const clearing = store.getState().clearConversation(1);
  assert.equal(store.getState().conversationClearing['1'], true);
  assert.equal(await store.getState().messageSend(1, 'bloqueado'), false);
  const expected = assert.rejects(clearing, /No se pudo confirmar el borrado/);
  deleting.reject(new Error('offline'));
  await expected;
  assert.deepEqual(Array.from(store.getState().messagesList, (row) => row.id), [10]);
  assert.equal(Boolean(store.getState().conversationClearing['1']), false);
  assert.equal(store.getState().pendingMessages.length, 1);
  assert.equal(textSends(socket).length, 2);
});

test('clear acknowledgments for already hidden UUIDs do not display their content or revive old pending text', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  await store.getState().messageSend(1, 'oculto');
  const pending = store.getState().pendingMessages[0];
  socket.receive('message.ack', { ...clearedHistory(), clientId: pending.clientId, messageId: 10, historyCleared: true });
  await settle();
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(Boolean(store.getState().friendList[0].message), false);
});

test('a stale revision error purges old text without raising a global alert and the next send uses the new revision', async () => {
  const { store, socket, alerts } = await connectedHarness();
  await store.getState().messageSend(1, 'viejo');
  socket.receive('error', { ...clearedHistory(), code: 'history_cleared', message: 'La conversación se borró.' });
  await settle();
  assert.equal(alerts.length, 0);
  assert.equal(store.getState().pendingMessages.length, 0);
  await store.getState().messageSend(1, 'nuevo');
  assert.equal(textSends(socket).at(-1).historyRevision, 1);
});

test('logout aborts a late DELETE and its result cannot change the next signed-in session', async () => {
  const deleting = deferred();
  let signal;
  const { store } = await connectedHarness({ deleteConversation: (_url, config) => { signal = config.signal; return deleting.promise; } });
  const clearing = store.getState().clearConversation(1);
  const rejected = assert.rejects(clearing, (error) => error.code === 'SESSION_CHANGED');
  await store.getState().logout();
  assert.equal(signal.aborted, true);
  await store.getState().login(null, { username: 'me' }, { access: 'new-access', refresh: 'new-refresh' });
  deleting.resolve({ data: clearedHistory() });
  await rejected;
  assert.equal(Object.keys(store.getState().conversationHistory).length, 0);
  assert.equal(Object.keys(store.getState().conversationClearing).length, 0);
});

test('reconnect after an offline clear replaces the old history request and retrieves new messages beyond the cutoff', async () => {
  const { store, socket, sockets } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  socket.close();
  await store.getState().socketConnect();
  const replacement = sockets[1];
  replacement.open();
  const obsolete = historyResponse(store, [message(10)]);
  replacement.receive('friend.list', [{ id: 1, friend: { username: 'alice' }, ...clearedHistory() }]);
  assert.equal(store.getState().messagesLoading, true);
  assert.notEqual(store.getState().messagesRequestId, obsolete.requestId);
  replacement.receive('message.list', obsolete);
  assert.equal(store.getState().messagesLoading, true);
  replacement.receive('message.list', historyResponse(store, [message(25)], clearedHistory()));
  assert.equal(store.getState().messagesLoading, false);
  assert.deepEqual(Array.from(store.getState().messagesList, (row) => row.id), [25]);
});

test('hidden ACK metadata restarts a stale open history request without showing the hidden message', async () => {
  const { store, socket } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  store.getState().messageList(1);
  const request = store.getState().messagesRequestId;
  socket.receive('message.ack', { ...clearedHistory(), historyCleared: true,
    clientId: '88888888-8888-4888-8888-888888888888', messageId: 10 });
  assert.equal(store.getState().messagesLoading, true);
  assert.notEqual(store.getState().messagesRequestId, request);
  socket.receive('message.list', historyResponse(store, [message(26)], clearedHistory()));
  assert.deepEqual(Array.from(store.getState().messagesList, (row) => row.id), [26]);
});

test('an identical server revision retries a failed durable purge so an invisible full queue cannot block new text', async () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    clientId: `88888888-8888-4888-8888-${String(index + 1).padStart(12, '0')}`, connectionId: 1,
    text: `viejo ${index}`, created: message(1).created, deliveryStatus: 'pending', historyRevision: 0,
  }));
  let fail = false;
  const disk = durableStorage({ values: new Map([['chat.outbox.v1:me', JSON.stringify({ version: 1, messages })]]),
    beforeWrite: () => { if (fail) throw new Error('fallo temporal'); } });
  const { store, socket } = await connectedHarness({ asyncStorage: disk });
  fail = true;
  socket.receive('message_history_cleared', clearedHistory());
  await settle();
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(JSON.parse(disk.values.get('chat.outbox.v1:me')).messages.length, 100);
  fail = false;
  socket.receive('friend.list', [{ id: 1, friend: { username: 'alice' }, ...clearedHistory() }]);
  await settle();
  assert.equal(JSON.parse(disk.values.get('chat.outbox.v1:me')).messages.length, 0);
  assert.equal(await store.getState().messageSend(1, 'libre'), true);
  assert.equal(textSends(socket).at(-1).historyRevision, 1);
});

test('case-distinct contacts route previews, read receipts and clear metadata by connection without mixing conversation contents', async () => {
  const { store, socket } = await connectedHarness();
  socket.receive('friend.list', [{ id: 1, friend: { username: 'Alice' }, unreadCount: 2 },
    { id: 2, friend: { username: 'alice' }, unreadCount: 3 }]);
  store.getState().openMessagesThread('Alice', 1);
  socket.receive('message.send', { ...payload(30, 'alice'), connectionId: 2 });
  assert.equal(store.getState().messagesList.length, 0);
  assert.equal(store.getState().friendList.find((row) => row.id === 1).unreadCount, 2);
  assert.equal(store.getState().friendList.find((row) => row.id === 2).message.id, 30);
  socket.receive('message.send', { ...payload(31, 'Alice'), connectionId: 1 });
  const read = socket.sent.filter((packet) => packet.source === 'message.read').at(-1);
  assert.equal(read.connectionId, 1);
  assert.equal(store.getState().friendList.find((row) => row.id === 2).unreadCount, 4);
  store.getState().openMessagesThread('alice', 2);
  assert.equal(store.getState().messagesList.length, 0);
  socket.receive('message_history_cleared', clearedHistory({ connectionId: 1, clearedThrough: 31 }));
  assert.equal(store.getState().friendList.find((row) => row.id === 2).message.id, 30);
});

test('accepting a text message waits for durable storage before sending or clearing the caller editor', async () => {
  const gate = deferred();
  const disk = durableStorage({ beforeWrite: () => gate.promise });
  const { store, socket } = await connectedHarness({ asyncStorage: disk });
  const saving = store.getState().messageSend(1, '  texto seguro  ');
  await settle();
  assert.equal(textSends(socket).length, 0);
  assert.equal(store.getState().pendingMessages.length, 0);
  gate.resolve();
  assert.equal(await saving, true);
  const sent = textSends(socket)[0];
  const persisted = JSON.parse(disk.values.get('chat.outbox.v1:me')).messages[0];
  assert.equal(sent.clientId, persisted.clientId);
  assert.equal(sent.message, 'texto seguro');
  assert.equal(store.getState().pendingMessages[0].deliveryStatus, 'sending');
});

test('a local write failure rejects the send and leaves transport and local bubbles untouched', async () => {
  let fail = true;
  const disk = durableStorage({ beforeWrite: () => { if (fail) throw new Error('almacenamiento lleno'); } });
  const { store, socket } = await connectedHarness({ asyncStorage: disk });
  assert.equal(await store.getState().messageSend(1, 'conservar editor'), false);
  assert.equal(textSends(socket).length, 0);
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.match(store.getState().outboxError, /almacenamiento lleno/);
  fail = false;
  assert.equal(await store.getState().messageSend(1, 'conservar editor'), true);
  assert.equal(textSends(socket).length, 1);
  assert.equal(store.getState().outboxError, null);
});

test('offline text is durable and reconnect sends one item at a time without merging identical text', async () => {
  let online = false;
  const { store, sockets, asyncStorage } = coreHarness({ getAccessToken: async () => {
    if (!online) throw new Error('offline');
    return 'access';
  } });
  await store.getState().login(null, { username: 'me' }, { access: 'access', refresh: 'refresh' });
  assert.equal(await store.getState().messageSend(1, 'igual'), true);
  assert.equal(await store.getState().messageSend(1, 'igual'), true);
  await settle();
  const pending = [...store.getState().pendingMessages];
  assert.equal(pending.length, 2);
  assert.notEqual(pending[0].clientId, pending[1].clientId);
  assert.equal(JSON.parse(asyncStorage.values.get('chat.outbox.v1:me')).messages.length, 2);
  assert.equal(sockets.length, 0);
  online = true;
  await store.getState().socketConnect();
  const socket = sockets[0];
  socket.open();
  assert.equal(textSends(socket).length, 0);
  socket.receive('friend.list', [{ id: 1, friend: { username: 'alice' }, revision: 0, clearedThrough: 0 }]);
  assert.equal(textSends(socket).length, 1);
  assert.equal(textSends(socket)[0].clientId, pending[0].clientId);
  socket.receive('message.send', textAck(pending[0]));
  assert.equal(textSends(socket).length, 2);
  assert.equal(textSends(socket)[1].clientId, pending[1].clientId);
  socket.receive('message.send', textAck(pending[1], 501));
  await settle();
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(JSON.parse(asyncStorage.values.get('chat.outbox.v1:me')).messages.length, 0);
});

test('a lost acknowledgment reconnects with the original UUID and duplicate confirmations add one server message', async () => {
  const { store, socket, sockets, timers, asyncStorage } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  await store.getState().messageSend(1, 'mensaje único');
  const pending = { ...store.getState().pendingMessages[0] };
  const oldDeadline = [...timers.values()].find((timer) => timer.delay === 15000);
  socket.close();
  assert.equal(store.getState().pendingMessages[0].deliveryStatus, 'pending');
  assert.equal([...timers.values()].some((timer) => timer === oldDeadline), false);
  await store.getState().socketConnect();
  const replacement = sockets[1];
  replacement.open();
  assert.equal(textSends(replacement).length, 0);
  replacement.receive('friend.list', [{ id: 1, friend: { username: 'alice' }, revision: 0, clearedThrough: 0 }]);
  assert.equal(textSends(replacement)[0].clientId, pending.clientId);
  replacement.receive('message.send', textAck(pending));
  replacement.receive('message.send', textAck(pending));
  socket.receive('message.send', textAck(pending));
  oldDeadline.callback();
  await settle();
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(store.getState().messagesList.length, 1);
  assert.equal(store.getState().messagesList[0].id, 500);
  assert.equal(JSON.parse(asyncStorage.values.get('chat.outbox.v1:me')).messages.length, 0);
});

test('an acknowledgment deadline creates a durable failure and reconnect waits for an explicit retry using the same UUID', async () => {
  const { store, socket, sockets, timers, asyncStorage } = await connectedHarness();
  await store.getState().messageSend(1, 'sin confirmación');
  const pending = store.getState().pendingMessages[0];
  [...timers.values()].find((timer) => timer.delay === 15000).callback();
  await settle();
  assert.equal(store.getState().pendingMessages[0].deliveryStatus, 'failed');
  assert.equal(JSON.parse(asyncStorage.values.get('chat.outbox.v1:me')).messages[0].deliveryStatus, 'failed');
  socket.close();
  await store.getState().socketConnect();
  const replacement = sockets[1];
  replacement.open();
  assert.equal(textSends(replacement).length, 0);
  replacement.receive('friend.list', [{ id: 1, friend: { username: 'alice' }, revision: 0, clearedThrough: 0 }]);
  assert.equal(await store.getState().retryPendingMessage(pending.clientId), true);
  assert.equal(textSends(replacement).length, 1);
  assert.equal(textSends(replacement)[0].clientId, pending.clientId);
  assert.equal(store.getState().pendingMessages[0].deliveryStatus, 'sending');
});

test('correlated permission errors stay on the pending bubble and late errors after discard never raise a global alert', async () => {
  const { store, socket, alerts, errorLogs } = await connectedHarness();
  await store.getState().messageSend(1, 'rechazado');
  const pending = store.getState().pendingMessages[0];
  const error = { message: 'No tienes permiso.', clientId: pending.clientId, connectionId: 1 };
  socket.onmessage({ data: JSON.stringify({ source: 'error', ...error }) });
  assert.equal(store.getState().pendingMessages[0].deliveryStatus, 'failed');
  assert.equal(store.getState().pendingMessages[0].deliveryError, 'No tienes permiso.');
  assert.equal(await store.getState().discardPendingMessage(pending.clientId), true);
  socket.receive('error', error);
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(errorLogs.length, 0);
});

test('history confirmation removes only a matching own UUID in the same connection', async () => {
  const { store, socket, asyncStorage } = await connectedHarness();
  store.getState().openMessagesThread('alice', 1);
  await store.getState().messageSend(1, 'a Alice');
  await store.getState().messageSend(2, 'a Bob');
  const [alice, bob] = store.getState().pendingMessages;
  store.getState().confirmPendingMessages([{ ...textAck(alice).message, is_me: false }], 1);
  store.getState().confirmPendingMessages([textAck(alice).message], 2);
  assert.equal(store.getState().pendingMessages.length, 2);
  store.getState().messageList(1);
  socket.receive('message.list', historyResponse(store, [textAck(alice).message]));
  assert.equal(store.getState().pendingMessages.length, 1);
  assert.equal(store.getState().pendingMessages[0].clientId, bob.clientId);
  assert.equal(store.getState().messagesList[0].clientId, alice.clientId);
  await settle();
  assert.equal(JSON.parse(asyncStorage.values.get('chat.outbox.v1:me')).messages[0].clientId, bob.clientId);
});

test('case-distinct friends use the server ownership flag so a remote UUID collision cannot acknowledge an own pending message', async () => {
  const { store, sockets, asyncStorage } = coreHarness();
  await store.getState().login(null, { username: 'Me' }, { access: 'access', refresh: 'refresh' });
  await store.getState().socketConnect();
  const socket = sockets[0];
  socket.open();
  socket.receive('friend.list', [{ id: 1, friend: { username: 'me' }, unreadCount: 0 }]);
  store.getState().openMessagesThread('me', 1);
  await store.getState().messageSend(1, 'propio');
  const pending = store.getState().pendingMessages[0];
  socket.receive('message.send', {
    connectionId: 1, friend: { username: 'me' }, sender: { username: 'me' }, receiver: { username: 'Me' },
    message: { ...message(500, 'remoto', false), clientId: pending.clientId },
  });
  assert.equal(store.getState().pendingMessages.length, 1);
  assert.equal(store.getState().pendingMessages[0].clientId, pending.clientId);
  assert.equal(store.getState().messagesList[0].text, 'remoto');
  assert.equal(store.getState().messagesList[0].is_me, false);
  socket.receive('message.send', {
    connectionId: 1, friend: { username: 'me' }, sender: { username: 'Me' }, receiver: { username: 'me' },
    message: { ...message(501, 'propio', true), clientId: pending.clientId },
  });
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(store.getState().messagesList.find((item) => item.id === 501).is_me, true);
  assert.equal(store.getState().messagesList.find((item) => item.id === 500).is_me, false);
  await settle();
  assert.equal(JSON.parse(asyncStorage.values.get('chat.outbox.v1:Me')).messages.length, 0);
});

test('logout preserves the first account queue and a differently cased account never loads or transmits it', async () => {
  const disk = durableStorage();
  const { store, sockets } = coreHarness({ asyncStorage: disk, getAccessToken: async () => { throw new Error('offline'); } });
  await store.getState().login(null, { username: 'Me' }, { access: 'A', refresh: 'A-refresh' });
  await store.getState().messageSend(1, 'cuenta A');
  const clientId = store.getState().pendingMessages[0].clientId;
  await store.getState().logout();
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(JSON.parse(disk.values.get('chat.outbox.v1:Me')).messages[0].clientId, clientId);
  await store.getState().login(null, { username: 'me' }, { access: 'B', refresh: 'B-refresh' });
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(sockets.length, 0);
  await store.getState().login(null, { username: 'Me' }, { access: 'A', refresh: 'A-refresh' });
  assert.equal(store.getState().pendingMessages[0].clientId, clientId);
});

test('a pending disk write cannot send or repopulate messages after the account changes', async () => {
  const gate = deferred();
  const disk = durableStorage({ beforeWrite: () => gate.promise });
  const { store, socket } = await connectedHarness({ asyncStorage: disk });
  const sending = store.getState().messageSend(1, 'para la cuenta anterior');
  await settle();
  await store.getState().logout();
  await store.getState().login(null, { username: 'other' }, { access: 'other', refresh: 'other-refresh' });
  gate.resolve();
  assert.equal(await sending, false);
  assert.equal(store.getState().user.username, 'other');
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(textSends(socket).length, 0);
  assert.equal(JSON.parse(disk.values.get('chat.outbox.v1:me')).messages[0].text, 'para la cuenta anterior');
  assert.equal(disk.values.has('chat.outbox.v1:other'), false);
});

test('a cached profile cannot send its outbox with a different account token before the server identifies the session', async () => {
  const profile = deferred();
  const old = { id: 'pending:11111111-1111-4111-8111-111111111111', clientId: '11111111-1111-4111-8111-111111111111',
    connectionId: 1, text: 'privado de A', created: message(1).created, deliveryStatus: 'pending' };
  const disk = durableStorage({ values: new Map([['chat.outbox.v1:A', JSON.stringify({ version: 1, messages: [old] })]]) });
  const secure = storage({ tokens: { access: 'token-B', refresh: 'refresh-B' }, user: { username: 'A' } });
  const { store, sockets } = coreHarness({ secure, asyncStorage: disk, getProfile: () => profile.promise });
  const initializing = store.getState().init();
  await settle();
  assert.equal(store.getState().pendingMessages[0].clientId, old.clientId);
  await store.getState().socketConnect();
  sockets[0].open();
  assert.equal(textSends(sockets[0]).length, 0);
  assert.equal(store.getState().outboxIdentityVerified, false);
  profile.resolve({ data: { user: { username: 'B' } } });
  await initializing;
  await settle();
  assert.equal(store.getState().user.username, 'B');
  assert.equal(store.getState().outboxIdentityVerified, true);
  assert.equal(store.getState().pendingMessages.length, 0);
  assert.equal(textSends(sockets[0]).length, 0);
  assert.equal(JSON.parse(disk.values.get('chat.outbox.v1:A')).messages[0].text, 'privado de A');
});

test('a session restored offline verifies its identity and resumes its queue when the connection returns', async () => {
  let online = false;
  const saved = { clientId: '22222222-2222-4222-8222-222222222222', connectionId: 1,
    text: 'esperando red', created: message(1).created, deliveryStatus: 'pending' };
  const disk = durableStorage({ values: new Map([['chat.outbox.v1:me', JSON.stringify({ version: 1, messages: [saved] })]]) });
  const { store, sockets } = coreHarness({ asyncStorage: disk,
    secure: storage({ tokens: { access: 'access', refresh: 'refresh' }, user: { username: 'me' } }),
    getProfile: async () => { if (!online) throw new Error('offline'); return { data: { user: { username: 'me' } } }; },
  });
  await store.getState().init();
  assert.equal(store.getState().authenticated, true);
  assert.equal(store.getState().outboxIdentityVerified, false);
  online = true;
  await store.getState().socketConnect();
  sockets[0].open();
  await settle();
  assert.equal(store.getState().outboxIdentityVerified, true);
  assert.equal(textSends(sockets[0]).length, 0);
  sockets[0].receive('friend.list', [{ id: 1, friend: { username: 'alice' }, revision: 0, clearedThrough: 0 }]);
  assert.equal(textSends(sockets[0])[0].clientId, saved.clientId);
});

test('a confirmed own message replaces its local bubble without inventing a read receipt or merging a received UUID collision', () => {
  const { mergeMessages } = loadModule('messages.js');
  const clientId = '33333333-3333-4333-8333-333333333333';
  const server = { ...message(100, 'igual', true), clientId };
  const local = { ...server, id: `pending:${clientId}`, isNew: false, deliveryStatus: 'sending' };
  const received = { ...message(101, 'igual', false), clientId };
  const merged = mergeMessages([server, received], [local]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.is_me).id, 100);
  assert.equal(merged.find((item) => item.is_me).isNew, true);
  assert.equal(merged.find((item) => item.is_me).deliveryStatus, undefined);
});

test('pending text and confirmed media share the same latest-50 display limit with deterministic tied ordering', () => {
  const { mergeMessages } = loadModule('messages.js');
  const server = Array.from({ length: 49 }, (_, index) => mediaPayload(index + 1, 'image', index % 2 === 0).message);
  const pending = ['a', 'b', 'c'].map((suffix) => ({ ...message(60, 'pendiente', true), id: `pending:${suffix}`, clientId: suffix, deliveryStatus: 'pending' }));
  const result = mergeMessages(server, pending);
  assert.equal(result.length, 50);
  assert.deepEqual(Array.from(result.slice(0, 3), (item) => item.id), ['pending:c', 'pending:b', 'pending:a']);
  assert.equal(result.at(-1).id, 3);
});

function jwt(secondsFromNow) {
  const encoded = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString('base64url');
  return `header.${encoded}.signature`;
}

function apiHarness(options = {}) {
  const secure = options.secure || storage({ tokens: { access: jwt(300), refresh: 'refresh' } });
  const requests = [];
  const refreshRequests = [];
  const expired = [];
  const mockAxios = {
    create(config) {
      return axios.create({ ...config, adapter: async (request) => {
        requests.push(request);
        if (options.adapter) return options.adapter(request, requests.length);
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config: request };
      } });
    },
    async post(...args) {
      refreshRequests.push(args);
      if (options.refresh) return options.refresh(...args);
      return { data: { access: jwt(300) } };
    },
  };
  const exported = loadModule('api.js', {
    axios: mockAxios,
    'expo-constants': {},
    'react-native': { Platform: { OS: 'android', select: (values) => values.android } },
    './secure': secure,
  }, {
    process: { env: { EXPO_PUBLIC_API_URL: 'http://127.0.0.1:8000' } },
    __DEV__: true,
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
  });
  exported.setSessionExpiredHandler(() => expired.push(true));
  return { ...exported, secure, requests, refreshRequests, expired };
}

test('hosted web uses its HTTPS origin for REST and secure WebSockets', () => {
  const exported = loadModule('api.js', {
    axios,
    'expo-constants': {},
    'react-native': { Platform: { OS: 'web', select: (values) => values.web } },
    './secure': storage(),
  }, {
    process: { env: { EXPO_PUBLIC_API_SAME_ORIGIN: 'true' } },
    window: { location: { origin: 'https://messaging.example', hostname: 'messaging.example', protocol: 'https:' } },
    __DEV__: false,
  });
  assert.equal(exported.API_BASE_URL, 'https://messaging.example');
  assert.equal(exported.WS_BASE_URL, 'wss://messaging.example');
});

test('API automatically renews expired JWT and shares the renewal across concurrent requests', async () => {
  const pending = deferred();
  const secure = storage({ tokens: { access: jwt(-30), refresh: 'refresh' } });
  const harness = apiHarness({ secure, refresh: () => pending.promise });
  const first = harness.default.get('/chat/me/');
  const second = harness.default.get('/chat/me/');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.refreshRequests.length, 1);
  const access = jwt(600);
  pending.resolve({ data: { access } });
  await Promise.all([first, second]);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[0].headers.get('Authorization'), `Bearer ${access}`);
});

test('multipart uploads preserve FormData and leave Content-Type to the native transport', async () => {
  const harness = apiHarness();
  const form = new FormData();
  form.append('connectionId', '1');
  form.append('type', 'image');
  form.append('file', new Blob(['image'], { type: 'image/jpeg' }), 'image.jpg');
  await harness.default.post('/chat/messages/media/', form);
  assert.equal(harness.requests[0].data, form);
  assert.equal(harness.requests[0].headers.get('Content-Type'), false);
  assert.ok(harness.requests[0].headers.get('Authorization').startsWith('Bearer '));
});

test('sign-in requests do not carry an old access token or attempt refresh', async () => {
  const harness = apiHarness({ secure: storage({ tokens: { access: jwt(-1), refresh: 'refresh' } }) });
  await harness.default.post('/chat/signin/', { username: 'me', password: 'secret' });
  assert.equal(harness.requests[0].headers.get('Authorization'), undefined);
  assert.equal(harness.refreshRequests.length, 0);
});

test('public password recovery ignores an expired other-account token and never refreshes or expires that session on errors', async () => {
  for (const url of ['/chat/password-reset/request/', '/chat/password-reset/confirm/']) {
    for (const status of [400, 401]) {
      const secure = storage({ tokens: { access: jwt(-1), refresh: 'other-refresh' } });
      const harness = apiHarness({ secure, adapter: async (config) => {
        throw new axios.AxiosError('Recovery rejected', 'ERR_BAD_REQUEST', config, null, { status, data: { detail: 'Invalid request' }, config });
      } });
      await assert.rejects(harness.default.post(url, { email: 'test@example.com' }), /Recovery rejected/);
      assert.equal(harness.requests[0].headers.get('Authorization'), undefined);
      assert.equal(harness.refreshRequests.length, 0);
      assert.equal(harness.expired.length, 0);
      assert.equal(secure.values.get('tokens').refresh, 'other-refresh');
    }
  }
});

test('a public recovery request leaves a concurrent private response in the same authentication generation', async () => {
  const gate = deferred();
  const harness = apiHarness({ adapter: async (config) => config.url === '/chat/me/' ? gate.promise : ({ data: {}, status: 200, headers: {}, config }) });
  const profile = harness.default.get('/chat/me/');
  await settle();
  await harness.default.post('/chat/password-reset/request/', { email: 'test@example.com' });
  const config = harness.requests.find((request) => request.url === '/chat/me/');
  gate.resolve({ data: { user: { username: 'me' } }, status: 200, headers: {}, config });
  assert.equal((await profile).data.user.username, 'me');
  assert.equal(harness.expired.length, 0);
});

test('renewal rejected by the server expires the session', async () => {
  const harness = apiHarness({ secure: storage({ tokens: { access: jwt(-1), refresh: 'refresh' } }), refresh: async () => {
    const error = new Error('expired');
    error.response = { status: 401 };
    throw error;
  } });
  await assert.rejects(harness.default.get('/chat/me/'), /expired/);
  assert.equal(harness.expired.length, 1);
});

test('an offline renewal preserves saved tokens and does not expire the session', async () => {
  const harness = apiHarness({ secure: storage({ tokens: { access: jwt(-1), refresh: 'refresh' } }), refresh: async () => { throw new Error('offline'); } });
  await assert.rejects(harness.default.get('/chat/me/'), /offline/);
  assert.equal(harness.expired.length, 0);
  assert.equal(harness.secure.values.get('tokens').refresh, 'refresh');
});

test('renewal completing after logout cannot restore stale tokens', async () => {
  const pending = deferred();
  const harness = apiHarness({ secure: storage({ tokens: { access: jwt(-1), refresh: 'refresh' } }), refresh: () => pending.promise });
  const refreshing = harness.getAccessToken();
  await new Promise((resolve) => setImmediate(resolve));
  harness.resetAuthSession();
  await harness.secure.wipe();
  pending.resolve({ data: { access: jwt(600) } });
  await assert.rejects(refreshing, { code: 'SESSION_CHANGED' });
  assert.equal(harness.secure.values.size, 0);
});

test('an API 401 retries once with a renewed access token', async () => {
  const harness = apiHarness({ adapter: async (config, count) => {
    if (count === 1) throw new axios.AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, { status: 401 });
    return { data: { ok: true }, status: 200, headers: {}, config };
  } });
  const response = await harness.default.get('/chat/me/');
  assert.equal(response.data.ok, true);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.refreshRequests.length, 1);
});

test('a private API response completed after switching accounts is discarded', async () => {
  const pending = deferred();
  const harness = apiHarness({ adapter: async (config) => {
    await pending.promise;
    return { data: { friend: { username: 'old-friend' }, message: message(9) }, status: 200, headers: {}, config };
  } });
  const uploading = harness.default.post('/chat/messages/media/', { type: 'image' });
  await new Promise((resolve) => setImmediate(resolve));
  harness.resetAuthSession();
  await harness.secure.set('tokens', { access: jwt(600), refresh: 'new-account-refresh' });
  pending.resolve();
  await assert.rejects(uploading, { code: 'SESSION_CHANGED' });
});

test('relative media paths are joined correctly without changing absolute or local URIs', () => {
  const harness = apiHarness();
  assert.equal(harness.resolveMediaUrl('media/photo.jpg'), 'http://127.0.0.1:8000/media/photo.jpg');
  assert.equal(harness.resolveMediaUrl('/media/photo.jpg'), 'http://127.0.0.1:8000/media/photo.jpg');
  assert.equal(harness.resolveMediaUrl('file:///recording.m4a'), 'file:///recording.m4a');
  assert.equal(harness.resolveMediaUrl('https://cdn.example/photo.jpg'), 'https://cdn.example/photo.jpg');
});

test('secure storage queues logout deletion after a pending token write', async () => {
  const pending = deferred();
  const values = new Map();
  const secure = loadModule('secure.js', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-secure-store': {
      async setItemAsync(key, value) { await pending.promise; values.set(key, value); },
      async getItemAsync(key) { return values.get(key); },
      async deleteItemAsync(key) { values.delete(key); },
    },
  }).default;
  const saving = secure.set('tokens', { access: 'old' });
  const wiping = secure.wipe();
  pending.resolve();
  await Promise.all([saving, wiping]);
  assert.equal(values.size, 0);
});

test('secure storage reports a write failure rather than silently accepting login', async () => {
  const secure = loadModule('secure.js', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-secure-store': {
      async setItemAsync() { throw new Error('storage unavailable'); },
      async getItemAsync() { return null; },
    },
  }).default;
  await assert.rejects(secure.set('tokens', { access: 'access' }), /storage unavailable/);
});

test('web session storage uses localStorage without calling a native module', async () => {
  const values = new Map();
  const secure = loadModule('secure.js', {
    'react-native': { Platform: { OS: 'web' } },
    'expo-secure-store': { setItemAsync() { throw new Error('native storage must not be called'); } },
  }, {
    localStorage: {
      setItem(key, value) { values.set(key, value); },
      getItem(key) { return values.get(key); },
      removeItem(key) { values.delete(key); },
    },
  }).default;
  await secure.set('tokens', { access: 'access' });
  assert.equal((await secure.get('tokens')).access, 'access');
  await secure.wipe();
  assert.equal(values.size, 0);
});
