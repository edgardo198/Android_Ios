const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function loadModule(relativePath, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [
      [require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
      require('@babel/plugin-transform-modules-commonjs'),
    ],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      return mocks[name];
    },
    ...globals,
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function typingClock() {
  let now = 0, sequence = 0;
  const pending = new Map();
  const globals = {
    Date: { now: () => now },
    setTimeout(callback, delay) { pending.set(++sequence, { callback, at: now + delay }); return sequence; },
    clearTimeout(id) { pending.delete(id); },
  };
  return { globals, pending,
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...pending.entries()].sort((left, right) => left[1].at - right[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at; pending.delete(next[0]); next[1].callback();
      }
      now = target;
    },
  };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (tree && typeof tree === 'object') return textContent(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

function renderer(makeComponent, initialProps = {}) {
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  let props = initialProps;
  let tree;
  const react = {
    memo: (component) => component,
    createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(factory, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, dependency) => !Object.is(value, slots[index].dependencies[dependency]))) {
        slots[index] = { value: factory(), dependencies };
      }
      return slots[index].value;
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies); },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !dependencies || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
    useLayoutEffect(effect, dependencies) { return react.useEffect(effect, dependencies); },
  };
  const Component = makeComponent(react);
  const render = () => {
    do {
      dirty = false;
      cursor = 0;
      effects = [];
      tree = Component(props);
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  };
  render();
  return {
    render,
    setProps(next) { props = next; return render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

const native = {
  View: 'View', FlatList: 'FlatList', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'web' },
  Keyboard: { dismiss() {} },
  StyleSheet: { create: (value) => value },
};
const messageHelpers = loadModule('src/core/messages.js');
const apiErrors = loadModule('src/common/apiError.js');

function screenHarness(options = {}) {
  const calls = { sends: [], retries: [], discards: [], starts: [], clears: [], types: [], drafts: [] };
  const listeners = new Set();
  const appStateListeners = new Set();
  const appState = { currentState: 'active', addEventListener(_event, listener) {
    appStateListeners.add(listener); return { remove: () => appStateListeners.delete(listener) };
  } };
  const store = {
    authenticated: true, user: { username: 'Me' }, conversationHistory: {}, conversationClearing: {},
    messagesList: [], pendingMessages: [], socketConnected: false, outboxError: null,
    clearMessages() {}, openMessagesThread() {}, messageList() {},
    messageType(connectionId, isTyping, draft) {
      if (!store.authenticated) return false;
      calls.drafts.push({ connectionId, isTyping, draft });
      calls.types.push({ connectionId, isTyping }); return true;
    },
    async messageSend(connectionId, text) {
      calls.sends.push({ connectionId, text });
      return options.send ? options.send(connectionId, text, store) : true;
    },
    async retryPendingMessage(clientId) { calls.retries.push(clientId); return options.retryResult ?? true; },
    async discardPendingMessage(clientId) { calls.discards.push(clientId); return options.discardResult ?? true; },
    async clearConversation(connectionId) { calls.clears.push(connectionId); return options.clear ? options.clear(connectionId, store) : { deletedCount: 1 }; },
    ...options.store,
  };
  const useGlobal = (selector) => selector(store);
  useGlobal.getState = () => store;
  useGlobal.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const navigation = { setOptions() {} };
  const route = { params: { id: options.connectionId || 7, friend: options.friend || { username: 'friend', name: 'Friend' } } };
  const media = { isBusy: false, isRecording: false, ...options.media };
  const callsProvider = { call: null, connected: true, availability: { available: true },
    async startCall(connectionId, kind, friend) {
      calls.starts.push({ connectionId, kind, friend });
      return options.startCall ? await options.startCall(connectionId, kind, friend) : true;
    }, ...options.callsProvider };
  const harness = renderer((react) => loadModule('src/screens/Messages.jsx', {
    react, 'react-native': { ...native, AppState: appState, Platform: { OS: options.platform || 'web' } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-navigation/native': { useFocusEffect: (effect) => react.useEffect(effect, [effect]) },
    'lodash/debounce': (callback) => Object.assign(callback, { cancel() {} }),
    '../components/Message/MessageInput': 'MessageInput', '../components/Message/MessageBubble': 'MessageBubble',
    '../components/Message/AttachmentPreview': 'AttachmentPreview',
    '../components/Message/ContactProfile': 'ContactProfile',
    '../components/Message/MessageTypingIndicator': 'MessageTypingIndicator',
    '../components/Message/useMessageMedia': () => media,
    '../common/WebBackButton': 'WebBackButton', '../common/Miniatura': 'Miniatura',
    '../common/DeleteConfirmation': 'DeleteConfirmation', '../common/apiError': apiErrors,
    '../core/global': useGlobal, '../core/messages': messageHelpers,
    '../core/typing': loadModule('src/core/typing.js', {}, options.typingGlobals),
    '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'FontAwesomeIcon' },
    '@fortawesome/free-solid-svg-icons': { faPhone: 'phone', faVideo: 'video', faTrash: 'trash' },
    '../calls/CallsProvider': { useCalls: () => callsProvider },
  }).default, { navigation, route });
  const input = () => nodes(harness.render(), (node) => node.type === 'MessageInput')[0].props;
  const list = () => nodes(harness.render(), (node) => node.type === 'FlatList')[0].props;
  return {
    ...harness, store, calls, input, list, callsProvider, media,
    appState(state) { appState.currentState = state; appStateListeners.forEach((listener) => listener(state)); },
    button: (label) => nodes(harness.render(), (node) => node.props.accessibilityLabel === label)[0],
    confirmation: () => nodes(harness.render(), (node) => node.type === 'DeleteConfirmation')[0]?.props,
    profile: () => nodes(harness.render(), (node) => node.type === 'ContactProfile')[0]?.props,
    openProfile() { nodes(harness.render(), (node) => String(node.props.accessibilityLabel || '').startsWith('Ver perfil de '))[0].props.onPress(); return harness.render(); },
    openDeletion() { this.openProfile(); this.profile().onDelete(); return harness.render(); },
    session(next, rerender = true) {
      const previous = { ...store }; Object.assign(store, next); listeners.forEach((listener) => listener(store, previous));
      if (rerender) harness.render();
    },
    type(text) { input().setMessage(text); return harness.render(); },
    changeConversation(id) { return harness.setProps({ navigation, route: { params: { id, friend: { username: `friend-${id}` } } } }); },
  };
}

test('offline text waits for durable acceptance and rapid taps enqueue once', async () => {
  const write = deferred();
  const h = screenHarness({ send: () => write.promise });
  h.type('  Offline text  ');
  assert.equal(h.input().disabled, false);
  const submit = h.input().onSend;
  const sending = submit();
  await submit();
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].text, 'Offline text');
  assert.equal(h.input().message, '  Offline text  ');
  assert.equal(h.input().isSending, true);
  write.resolve(true);
  await sending;
  assert.equal(h.input().message, '');
  assert.equal(h.input().isSending, false);
});

test('continuous typing starts immediately and sends heartbeats without waiting for a pause', () => {
  const clock = typingClock();
  const h = screenHarness({ store: { socketConnected: true }, typingGlobals: clock.globals });
  h.type('a');
  assert.deepEqual(h.calls.types, [{ connectionId: 7, isTyping: true }]);
  for (let index = 1; index <= 80; index += 1) {
    clock.advance(100);
    h.type('a'.repeat(index + 1));
  }
  assert.equal(h.calls.types.length, 5);
  assert.equal(h.calls.types.every((packet) => packet.isTyping === true), true);
  clock.advance(2499);
  assert.equal(h.calls.types.length, 5);
  clock.advance(1);
  assert.equal(h.calls.types.at(-1).isTyping, false);
  assert.equal(clock.pending.size, 0);
  assert.equal(h.calls.sends.length, 0);
});

test('clear, send, input blur and screen lifecycle stop typing and cancel old idle callbacks', async () => {
  for (const change of ['clear', 'send', 'blur', 'thread', 'revision', 'background', 'unmount', 'logout']) {
    const clock = typingClock();
    const h = screenHarness({ store: { socketConnected: true }, typingGlobals: clock.globals });
    h.type('Draft');
    assert.equal(h.calls.types[0].isTyping, true, change);
    const oldIdle = [...clock.pending.values()][0].callback;
    if (change === 'clear') h.type('');
    else if (change === 'send') await h.input().onSend();
    else if (change === 'blur') h.input().onBlur();
    else if (change === 'thread') h.changeConversation(8);
    else if (change === 'revision') h.session({ conversationHistory: { 7: { revision: 1 } } });
    else if (change === 'background') h.appState('background');
    else if (change === 'unmount') h.unmount();
    else h.session({ authenticated: false });
    assert.equal(clock.pending.size, 0, change);
    if (change !== 'logout') assert.equal(h.calls.types.at(-1).isTyping, false, change);
    const count = h.calls.types.length;
    oldIdle(); clock.advance(10000);
    assert.equal(h.calls.types.length, count, change);
  }
});

test('changing draft sharing clears transient publication while preserving the unsent editor', () => {
  const clock = typingClock();
  const h = screenHarness({ store: { socketConnected: true, outboxIdentityVerified: true,
    user: { username: 'Me', liveTypingEnabled: true, liveTypingRevision: 1 } }, typingGlobals: clock.globals });
  h.type('Shared first');
  assert.equal(h.calls.drafts[0].draft, 'Shared first');
  clock.advance(100); h.type('Newest unsent text');
  const oldCallback = [...clock.pending.values()].find((timer) => timer.at < 1000).callback;
  h.session({ user: { ...h.store.user, liveTypingEnabled: false, liveTypingRevision: 2 } });
  assert.equal(h.input().message, 'Newest unsent text');
  assert.equal(h.calls.drafts.at(-1).isTyping, false);
  const count = h.calls.drafts.length;
  oldCallback(); clock.advance(1000);
  assert.equal(h.calls.drafts.length, count);
  h.type('Now private');
  assert.equal(h.calls.drafts.at(-1).draft, null);
  assert.equal(h.calls.drafts.at(-1).isTyping, true);
  assert.equal(h.input().message, 'Now private');
  assert.equal(h.list().data.length, 0);
  h.unmount();
});

test('pending shared content is cancelled before conversation, revision, account and app lifecycle changes', () => {
  for (const change of ['thread', 'revision', 'account', 'background', 'blur', 'media', 'unmount']) {
    const clock = typingClock();
    const h = screenHarness({ store: { socketConnected: true, outboxIdentityVerified: true,
      user: { username: 'Me', liveTypingEnabled: true, liveTypingRevision: 1 } }, typingGlobals: clock.globals });
    h.type('First'); clock.advance(100); h.type(`Do not leak ${change}`);
    const stale = [...clock.pending.values()].find((timer) => timer.at < 1000).callback;
    if (change === 'thread') h.changeConversation(8);
    else if (change === 'revision') h.session({ conversationHistory: { 7: { revision: 2 } } });
    else if (change === 'account') h.session({ user: { username: 'Other', liveTypingEnabled: true, liveTypingRevision: 1 } });
    else if (change === 'background') h.appState('background');
    else if (change === 'blur') h.input().onBlur();
    else if (change === 'media') { h.media.isBusy = true; h.render(); }
    else h.unmount();
    const count = h.calls.drafts.length;
    stale(); clock.advance(10000);
    assert.equal(h.calls.drafts.length, count, change);
    assert.equal(h.calls.drafts.some((event) => event.draft === `Do not leak ${change}`), false, change);
    h.unmount();
  }
});

test('the draft preview renders plain bounded text without announcing each update or adding a message', () => {
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const Indicator = loadModule('src/components/Message/MessageTypingIndicator.jsx', {
    react: fakeReact, 'react-native': native,
    './MessageBubbleFriend': 'MessageBubbleFriend', '../../core/typing': loadModule('src/core/typing.js'),
  }).default;
  const tree = Indicator({ friend: { name: 'Friend', username: 'friend' }, draft: '<b>unsent</b> 😀'.repeat(100) });
  const preview = nodes(tree, (node) => node.props.numberOfLines === 3)[0];
  assert.ok(textContent(preview).startsWith('<b>unsent</b>'));
  assert.equal(Array.from(textContent(preview)).length, 500);
  assert.equal(preview.props.accessibilityLiveRegion, undefined);
  assert.equal(nodes(tree, (node) => node.props.accessibilityLiveRegion === 'polite').length, 1);
  assert.equal(nodes(Indicator({ friend: {}, draft: null }), (node) => node.props.numberOfLines === 3).length, 0);
});

test('the standalone typing indicator works in an empty thread and never consumes the 50-message history', () => {
  const h = screenHarness({ store: { messagesTyping: { username: 'friend', connectionId: 7 } } });
  const indicators = () => nodes(h.render(), (node) => node.type === 'MessageTypingIndicator');
  assert.equal(h.list().data.length, 0);
  assert.equal(indicators().length, 1);
  assert.equal(indicators()[0].props.friend.username, 'friend');
  h.store.messagesTyping.draft = 'Preview only';
  assert.equal(indicators()[0].props.draft, 'Preview only');
  assert.equal(h.list().data.length, 0);
  h.store.messagesList = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, created: new Date(index * 1000).toISOString(), text: 'history' }));
  assert.equal(h.list().data.length, 50);
  assert.equal(indicators().length, 1);
  h.store.messagesTyping = { username: 'Friend', connectionId: 7 };
  assert.equal(indicators().length, 0);
  h.store.messagesTyping = { username: 'friend', connectionId: 8 };
  assert.equal(indicators().length, 0);
  h.store.messagesTyping = { username: 'friend', connectionId: 7 };
  h.changeConversation(8);
  assert.equal(indicators().length, 0);
});

test('storage failure leaves the draft and exposes the store error inline on web', async () => {
  const h = screenHarness({ send: async (_id, _text, store) => {
    store.outboxError = 'No hay espacio para guardar el mensaje.';
    return false;
  } });
  h.type('Keep this draft');
  await h.input().onSend();
  assert.equal(h.input().message, 'Keep this draft');
  const errors = nodes(h.render(), (node) => node.props.accessibilityRole === 'alert');
  assert.equal(errors.length, 1);
  assert.match(textContent(errors[0]), /No hay espacio/);
  h.type('Edited draft');
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 0);
});

test('durable acceptance preserves text written during the asynchronous save', async () => {
  const write = deferred();
  const h = screenHarness({ send: () => write.promise });
  h.type('First message');
  const sending = h.input().onSend();
  h.type('Next message');
  write.resolve(true);
  await sending;
  assert.equal(h.input().message, 'Next message');
});

test('a slow save stops typing when the retyped submitted draft clears and preserves typing for a different next draft', async () => {
  for (const nextText of ['First message', 'Next message']) {
    const write = deferred();
    const clock = typingClock();
    const h = screenHarness({ send: () => write.promise, store: { socketConnected: true }, typingGlobals: clock.globals });
    h.type('First message');
    const saving = h.input().onSend();
    assert.equal(h.calls.types.at(-1).isTyping, false);
    h.type('First messag');
    h.type(nextText);
    assert.equal(h.calls.types.at(-1).isTyping, true);
    write.resolve(true);
    await saving;
    const cleared = nextText === 'First message';
    assert.equal(h.input().message, cleared ? '' : nextText);
    assert.equal(h.calls.types.at(-1).isTyping, !cleared);
    assert.equal(clock.pending.size, cleared ? 0 : 1);
    assert.equal(h.calls.sends.length, 1);
    assert.equal(h.calls.sends[0].text, 'First message');
    h.unmount();
  }
});

test('a save from the previous conversation cannot clear an identical new draft', async () => {
  const write = deferred();
  const h = screenHarness({ send: () => write.promise });
  h.type('Same words');
  const sending = h.input().onSend();
  h.changeConversation(8);
  h.type('Same words');
  write.resolve(true);
  await sending;
  assert.equal(h.input().message, 'Same words');
});

test('list isolates the conversation, removes acknowledged pending echoes and keeps 50 total', () => {
  const confirmed = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1, text: `Server ${index}`, created: new Date(1000 * (index + 1)).toISOString(),
  }));
  confirmed[49].clientId = 'confirmed-client';
  confirmed[49].is_me = true;
  const makePending = (clientId, connectionId = 7) => ({
    id: `pending:${clientId}`, clientId, connectionId, text: clientId,
    created: new Date(60000).toISOString(), is_me: true, deliveryStatus: 'pending',
  });
  const h = screenHarness({ store: {
    messagesList: confirmed,
    pendingMessages: [makePending('confirmed-client'), makePending('new-client'), makePending('other-chat', 8)],
  } });
  const data = h.list().data;
  assert.equal(data.length, 50);
  assert.equal(data[0].clientId, 'new-client');
  assert.equal(data.filter((item) => item.clientId === 'confirmed-client').length, 1);
  assert.equal(data.some((item) => item.clientId === 'other-chat'), false);
  assert.equal(data.some((item) => item.id === 1), false);
  const bubble = h.list().renderItem({ item: data[0], index: 0 });
  assert.equal(typeof bubble.props.onRetry, 'function');
  assert.equal(typeof bubble.props.onDiscard, 'function');
});

test('a remote reused UUID cannot hide an own pending message, while own acknowledgments ignore UUID case', () => {
  const clientId = '550e8400-e29b-41d4-a716-446655440000';
  const received = { id: 17, clientId, text: 'Remote message', is_me: false, created: new Date(50000).toISOString() };
  const pending = {
    id: `pending:${clientId}`, clientId, connectionId: 7, text: 'Own pending', is_me: true,
    created: new Date(60000).toISOString(), deliveryStatus: 'pending',
  };
  const h = screenHarness({ store: { messagesList: [received], pendingMessages: [pending] } });
  assert.equal(h.list().data.length, 2);
  assert.equal(h.list().data.some((item) => item.id === pending.id), true);
  h.store.messagesList = [{ ...received, clientId: clientId.toUpperCase() }];
  assert.equal(h.list().data.length, 2);
  h.store.messagesList = [{ ...received, clientId: clientId.toUpperCase(), is_me: true }];
  assert.equal(h.list().data.length, 1);
  assert.equal(h.list().data[0].id, received.id);
});

function bubbleHarness(message, options = {}) {
  return renderer((react) => loadModule('src/components/Message/MessageBubbleMe.js', {
    react, 'react-native': native, './MessageContent': 'MessageContent', './MessageMetadata': 'MessageMetadata', '../../Styles/messageStyles': {},
  }).default, { message, onRetry: options.onRetry, onDiscard: options.onDiscard });
}

test('unconfirmed text exposes honest feedback and local-only removal; sending has no actions', async () => {
  const calls = [];
  const h = bubbleHarness({ text: 'Hello', clientId: 'uuid', deliveryStatus: 'failed', deliveryError: 'No llegó la confirmación.' }, {
    onRetry: async (id) => calls.push(['retry', id]), onDiscard: async (id) => calls.push(['discard', id]),
  });
  assert.match(textContent(h.render()), /Sin confirmación/);
  assert.match(textContent(h.render()), /sin duplicar/);
  assert.match(textContent(h.render()), /no borra mensajes que ya llegaron/);
  const buttons = nodes(h.render(), (node) => node.type === 'TouchableOpacity');
  assert.equal(buttons.length, 2);
  await buttons[0].props.onPress();
  await buttons[1].props.onPress();
  assert.deepEqual(calls, [['retry', 'uuid'], ['discard', 'uuid']]);
  const sending = bubbleHarness({ text: 'Hello', clientId: 'uuid', deliveryStatus: 'sending' });
  assert.match(textContent(sending.render()), /Enviando/);
  assert.equal(nodes(sending.render(), (node) => node.type === 'TouchableOpacity').length, 0);
  const confirmed = bubbleHarness({ id: 4, text: 'Hello' });
  assert.equal(nodes(confirmed.render(), (node) => node.type === 'Text').length, 0);
});

test('pending actions prevent simultaneous retry and discard before a render', async () => {
  const action = deferred();
  const calls = [];
  const h = bubbleHarness({ text: 'Hello', clientId: 'uuid', deliveryStatus: 'pending' }, {
    onRetry: async () => { calls.push('retry'); await action.promise; },
    onDiscard: async () => { calls.push('discard'); },
  });
  const buttons = nodes(h.render(), (node) => node.type === 'TouchableOpacity');
  const retrying = buttons[0].props.onPress();
  await buttons[1].props.onPress();
  assert.deepEqual(calls, ['retry']);
  assert.equal(nodes(h.render(), (node) => node.type === 'TouchableOpacity').every((node) => node.props.disabled), true);
  action.resolve();
  await retrying;
});

test('saving text keeps typing available while recording and upload protections remain', () => {
  const h = renderer((react) => loadModule('src/components/Message/MessageInput.js', {
    react, 'react-native': native,
    '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'FontAwesomeIcon' },
    '@fortawesome/free-solid-svg-icons': {}, '../Message/RecordingAnimation': 'RecordingAnimation', './ImageSourcePicker': 'ImageSourcePicker',
    './EmojiPicker': 'EmojiPicker', './emojiData': { insertEmojiAtSelection() {} },
    '@react-navigation/native': { useFocusEffect: (effect) => react.useEffect(effect, [effect]) },
    '../../core/global': { getState: () => ({ captureAuthSession: () => null }), subscribe: () => () => {} },
    '../../calls/CallsProvider': { useCalls: () => ({ call: null }) },
    '../../Styles/messageStyles': { textInput: {} },
  }).default, { message: 'Hello', isSending: true });
  assert.equal(nodes(h.render(), (node) => node.type === 'TextInput')[0].props.editable, true);
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityLabel === 'Guardando mensaje')[0].props.disabled, true);
  for (const attributes of [{ disabled: true }, { isRecording: true }]) {
    h.setProps({ message: 'Hello', ...attributes });
    assert.equal(nodes(h.render(), (node) => node.type === 'TextInput')[0].props.editable, false);
    assert.equal(nodes(h.render(), (node) => node.props.accessibilityLabel === 'Enviar mensaje')[0].props.disabled, true);
  }
  h.setProps({ message: 'Hello', isRecording: true });
  assert.match(textContent(h.render()), /Detener y revisar/);
  assert.doesNotMatch(textContent(h.render()), /Detener y enviar/);
});

test('attachment preview preserves the text draft and exposes picker failures in the composer', () => {
  const preview = { type: 'image', asset: { uri: 'file:///photo.png' }, fileName: 'photo.png' };
  const confirmPreview = () => true;
  const cancelPreview = () => true;
  const cancelUpload = () => true;
  const uploadProgress = { phase: 'uploading', loaded: 256, total: 1024, percent: 25 };
  const h = screenHarness({ media: { preview, previewError: 'Falló el envío.', isUploading: false, confirmPreview, cancelPreview, cancelUpload, uploadProgress } });
  h.type('Draft remains');
  const modal = nodes(h.render(), (node) => node.type === 'AttachmentPreview')[0];
  assert.equal(modal.props.preview, preview);
  assert.equal(modal.props.onConfirm, confirmPreview);
  assert.equal(modal.props.onCancel, cancelPreview);
  assert.equal(modal.props.onCancelUpload, cancelUpload);
  assert.equal(modal.props.uploadProgress, uploadProgress);
  assert.equal(modal.props.previewError, 'Falló el envío.');
  assert.equal(h.input().message, 'Draft remains');
  const failedPicker = screenHarness({ media: { previewError: 'No se pudo abrir el selector.' } });
  assert.match(textContent(nodes(failedPicker.render(), (node) => node.props.accessibilityRole === 'alert')[0]), /abrir el selector/);
});

test('web call buttons start only on a gesture, preserve the draft and prevent duplicate invitations', async () => {
  const invitation = deferred();
  const h = screenHarness({ startCall: () => invitation.promise });
  h.type('Draft while calling');
  const button = (label) => nodes(h.render(), (node) => node.props.accessibilityLabel === label)[0];
  assert.equal(h.calls.starts.length, 0);
  const start = button('Llamar por audio').props.onPress;
  const pending = start();
  assert.equal(await start(), false);
  assert.equal(h.calls.starts.length, 1);
  assert.deepEqual(h.calls.starts[0], { connectionId: 7, kind: 'audio', friend: { username: 'friend', name: 'Friend' } });
  invitation.resolve(true);
  assert.equal(await pending, true);
  assert.equal(await button('Iniciar videollamada').props.onPress(), true);
  assert.equal(h.calls.starts[1].kind, 'video');
  assert.equal(h.input().message, 'Draft while calling');
});

test('web calls explain insecure availability and never invite while unavailable, offline, recording or in another call', async () => {
  const reason = 'Abre la aplicación mediante HTTPS o localhost para usar las llamadas en este navegador.';
  for (const options of [
    { callsProvider: { availability: { available: false, reason } } },
    { callsProvider: { connected: false } },
    { media: { isRecording: true } },
    { callsProvider: { call: { id: 'existing', status: 'active' } } },
  ]) {
    const h = screenHarness(options);
    for (const label of ['Llamar por audio', 'Iniciar videollamada']) {
      const button = nodes(h.render(), (node) => node.props.accessibilityLabel === label)[0];
      assert.equal(button.props.disabled, true);
      assert.equal(await button.props.onPress(), false);
    }
    assert.equal(h.calls.starts.length, 0);
    if (options.callsProvider?.availability) assert.match(textContent(h.render()), /HTTPS.*localhost/);
  }
});

test('conversation deletion requires confirmation, preserves failures for retry and blocks new sends while clearing', async () => {
  const pending = deferred(); let attempts = 0;
  const h = screenHarness({ clear: async () => {
    if (++attempts === 1) throw new Error('No se pudo borrar la conversación.');
    return pending.promise;
  } });
  h.type('Keep until deletion succeeds');
  h.openDeletion();
  assert.equal(h.calls.clears.length, 0);
  assert.match(h.confirmation().message, /ambos participantes/);
  assert.match(h.confirmation().message, /pendientes se cancelarán/);
  h.confirmation().onCancel();
  assert.equal(h.confirmation(), undefined);
  assert.equal(h.calls.clears.length, 0);
  h.openDeletion();
  assert.equal(await h.confirmation().onConfirm(), false);
  assert.match(h.confirmation().error, /No se pudo borrar/);
  assert.equal(h.input().message, 'Keep until deletion succeeds');
  const sendBeforeDelete = h.input().onSend;
  const confirm = h.confirmation().onConfirm;
  const deleting = confirm();
  assert.equal(await confirm(), false);
  assert.deepEqual(h.calls.clears, [7, 7]);
  assert.equal(h.confirmation().busy, true);
  assert.equal(h.input().disabled, true);
  assert.match(h.input().disabledPlaceholder, /Borrando/);
  await sendBeforeDelete();
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.button('Llamar por audio').props.disabled, true);
  h.confirmation().onCancel();
  assert(h.confirmation());
  pending.resolve({ deletedCount: 2, revision: 1 });
  assert.equal(await deleting, true);
  assert.equal(h.input().message, '');
  assert.equal(h.input().disabled, false);
  assert.equal(h.confirmation(), undefined);
});

test('a shared deletion invalidates drafts and open confirmations before rendering and ignores an earlier text save', async () => {
  const save = deferred();
  const h = screenHarness({ send: () => save.promise });
  h.type('Old text');
  const sending = h.input().onSend();
  h.openDeletion();
  const oldConfirm = h.confirmation().onConfirm;
  h.session({ conversationHistory: { 7: { revision: 1, clearedAt: '2026-10-09T16:00:00Z' } },
    messagesList: [], pendingMessages: [] }, false);
  assert.equal(await oldConfirm(), false);
  assert.equal(h.calls.clears.length, 0);
  assert.equal(h.input().message, '');
  assert.equal(h.confirmation(), undefined);
  assert.match(textContent(h.render()), /se borró para ambos/);
  h.type('New text after deletion');
  save.resolve(true); await sending;
  assert.equal(h.input().message, 'New text after deletion');
});

test('late deletion success or failure cannot close a confirmation or clear a draft from another thread or session', async () => {
  for (const change of ['thread', 'session']) {
    const old = deferred();
    const h = screenHarness({ clear: () => old.promise });
    h.type('Old conversation'); h.openDeletion();
    const deleting = h.confirmation().onConfirm();
    if (change === 'thread') h.changeConversation(9);
    else {
      h.session({ authenticated: false }, false);
      h.session({ authenticated: true, user: { username: 'me' } });
    }
    h.type('Current draft'); h.openDeletion();
    if (change === 'thread') old.resolve({ deletedCount: 2, revision: 1 });
    else old.reject(new Error('Old private deletion error'));
    assert.equal(await deleting, false, change);
    assert.equal(h.input().message, 'Current draft', change);
    assert.equal(h.confirmation().busy, false, change);
    assert.equal(h.confirmation().error, null, change);
    assert.deepEqual(h.calls.clears, [7], change);
    assert.doesNotMatch(textContent(h.render()), /Old private deletion/, change);
  }
});

test('opening a contact profile preserves the draft and refreshes only the exact contact identity', () => {
  let mediaActions = 0;
  const onCamera = () => { mediaActions += 1; };
  const h = screenHarness({
    friend: { id: 33, username: 'Friend', name: 'Original', miniatura: 'old.jpg' },
    media: { onCamera },
    store: { friendList: [
      { id: 8, friend: { id: 33, username: 'Friend', name: 'Another conversation' } },
      { id: 7, friend: { id: 33, username: 'friend', name: 'Different account' } },
      { id: 7, friend: { id: 44, username: 'Friend', name: 'Different user ID' } },
      { id: 7, friend: { id: 33, username: 'Friend', name: 'Updated', miniatura: 'new.jpg' } },
    ] },
  });
  h.type('Keep my draft');
  assert.equal(h.profile(), undefined);
  assert.equal(h.button('Borrar conversación'), undefined);
  assert.equal(h.input().onCamera, onCamera);
  h.openProfile();
  assert.equal(h.profile().friend.name, 'Updated');
  assert.equal(h.profile().friend.miniatura, 'new.jpg');
  assert.equal(h.profile().friend.username, 'Friend');
  assert.equal(h.profile().friend.id, 33);
  h.session({ friendList: [{ id: 7, friend: { username: 'Friend', name: 'Latest', miniatura: 'latest.jpg' } }] });
  assert.equal(h.profile().friend.name, 'Latest');
  assert.equal(h.profile().friend.id, 33);
  assert.equal(h.profile().friend.username, 'Friend');
  h.profile().onClose();
  assert.equal(h.profile(), undefined);
  assert.equal(h.input().message, 'Keep my draft');
  assert.equal(mediaActions, 0);
  assert.deepEqual([h.calls.starts.length, h.calls.clears.length, h.calls.sends.length], [0, 0, 0]);
});

test('profile call actions close the sheet and require one explicit gesture per invitation', async () => {
  for (const kind of ['audio', 'video']) {
    const invitation = deferred();
    const h = screenHarness({ startCall: () => invitation.promise });
    h.type('Draft remains');
    h.openProfile();
    assert.equal(h.calls.starts.length, 0);
    const profile = h.profile();
    const action = kind === 'audio' ? profile.onAudioCall : profile.onVideoCall;
    const starting = action();
    assert.equal(await action(), false);
    assert.equal(h.profile(), undefined);
    assert.equal(h.confirmation(), undefined);
    assert.equal(h.calls.starts.length, 1);
    assert.equal(h.calls.starts[0].connectionId, 7);
    assert.equal(h.calls.starts[0].kind, kind);
    assert.equal(h.calls.starts[0].friend.username, 'friend');
    invitation.resolve(true);
    assert.equal(await starting, true);
    assert.equal(h.input().message, 'Draft remains');
  }
});

test('profile actions obey unavailable, offline, recording and clearing protections', async () => {
  for (const options of [
    { callsProvider: { availability: { available: false, reason: 'Usa una conexión segura.' } } },
    { callsProvider: { connected: false } },
    { media: { isRecording: true } },
    { store: { conversationClearing: { 7: true } } },
  ]) {
    const h = screenHarness(options);
    h.openProfile();
    const profile = h.profile();
    assert.equal(profile.callDisabled, true);
    assert.equal(typeof profile.callNotice, 'string');
    assert.equal(await profile.onAudioCall(), false);
    assert.equal(await profile.onVideoCall(), false);
    assert.equal(h.profile().visible, true);
    assert.equal(h.profile().friend.username, profile.friend.username);
    assert.equal(h.calls.starts.length, 0);
    if (options.media || options.store) {
      assert.equal(profile.deleteDisabled, true);
      assert.equal(profile.onDelete(), false);
      assert.equal(h.confirmation(), undefined);
    }
    h.profile().onClose();
    assert.equal(h.profile(), undefined);
  }
});

test('iOS waits for the contact sheet dismissal before presenting the shared deletion confirmation', async () => {
  const h = screenHarness({ platform: 'ios' });
  h.type('Draft before confirmation');
  h.openProfile();
  const profile = h.profile();
  assert.equal(profile.onDelete(), true);
  assert.equal(profile.onDelete(), false);
  assert.equal(h.profile().visible, false);
  assert.equal(h.confirmation(), undefined);
  assert.deepEqual(h.calls.clears, []);
  profile.onDismiss();
  assert.equal(h.profile(), undefined);
  assert.match(h.confirmation().message, /ambos participantes/);
  assert.equal(h.input().message, 'Draft before confirmation');
  profile.onDismiss();
  assert.deepEqual(h.calls.clears, []);
  assert.equal(await h.confirmation().onConfirm(), true);
  assert.deepEqual(h.calls.clears, [7]);
});

test('stale contact actions and iOS dismissals cannot operate on a new thread, session or history revision', async () => {
  for (const change of ['thread', 'session', 'revision', 'unmount']) {
    const h = screenHarness({ platform: 'ios' });
    h.openProfile();
    const previous = h.profile();
    assert.equal(previous.onDelete(), true);
    if (change === 'thread') h.changeConversation(8);
    else if (change === 'session') {
      h.session({ authenticated: false }, false);
      h.session({ authenticated: true, user: { username: 'Me' } });
    } else if (change === 'revision') {
      h.session({ conversationHistory: { 7: { revision: 1 } } });
    } else h.unmount();
    if (change !== 'unmount') {
      h.type('Current draft');
      h.openProfile();
    }
    const current = change === 'unmount' ? null : h.profile();
    assert.equal(await previous.onAudioCall(), false, change);
    assert.equal(previous.onDelete(), false, change);
    previous.onClose();
    previous.onDismiss();
    assert.equal(h.confirmation(), undefined, change);
    assert.deepEqual([h.calls.starts.length, h.calls.clears.length], [0, 0], change);
    if (current) {
      assert.equal(h.profile().friend.username, current.friend.username, change);
      assert.equal(h.profile().visible, true, change);
      assert.equal(h.input().message, 'Current draft', change);
    }
  }
});
