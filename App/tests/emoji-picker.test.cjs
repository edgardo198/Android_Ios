const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const compiled = new Map();

function load(relative, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, '..', relative);
  if (!compiled.has(filename)) compiled.set(filename, babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [['@babel/plugin-transform-react-jsx', { runtime: 'classic' }], '@babel/plugin-transform-modules-commonjs'],
  }).code);
  const module = { exports: {} };
  vm.runInNewContext(compiled.get(filename), { module, exports: module.exports, ...globals,
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock: ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
const data = load('src/components/Message/emojiData.js');

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function renderer(makeComponent, attributes = {}) {
  const slots = [];
  let props = attributes, cursor = 0, dirty = true, effects = [], tree;
  const react = {
    memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) slots[index] = { dependencies, value: factory() };
      return slots[index].value;
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies); },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) effects.push(() => {
        previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() };
      });
    },
  };
  const Component = makeComponent(react);
  const render = () => {
    for (let attempts = 0; attempts < 20; attempts++) {
      cursor = 0; dirty = false; effects = [];
      tree = Component(props); effects.forEach((effect) => effect());
      if (!dirty) return tree;
    }
    throw new Error('Unexpected render loop');
  };
  render();
  return { react, render, setProps(next) { props = { ...props, ...next }; return render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function native(platform = 'web') {
  return { Platform: { OS: platform }, View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Keyboard: { dismiss() {} }, useWindowDimensions: () => ({ width: 320, height: 480 }),
    StyleSheet: { create: (value) => value, absoluteFillObject: {} } };
}
function inputHarness(options = {}) {
  const events = { edits: [], sends: 0, gifs: 0, focus: 0, cursors: [] };
  let authGeneration = 1, focusCleanup, focusBody;
  const listeners = new Set(), frames = [];
  const state = { authenticated: true, user: { username: 'owner' }, messagesConnectionId: 1, messagesUsername: 'friend',
    conversationHistory: {}, conversationClearing: {},
    captureAuthSession: () => ({ generation: authGeneration, username: state.user.username }),
    isAuthSessionCurrent: (snapshot) => state.authenticated && snapshot?.generation === authGeneration && snapshot.username === state.user.username,
  };
  const calls = { call: null };
  let h;
  h = renderer((react) => load('src/components/Message/MessageInput.js', {
    react, 'react-native': native(options.platform), './emojiData': data,
    './EmojiPicker': 'EmojiPicker', './ImageSourcePicker': 'ImageSourcePicker', '../Message/RecordingAnimation': 'RecordingAnimation',
    '../../Styles/messageStyles': { textInput: {} },
    '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'FontAwesomeIcon' }, '@fortawesome/free-solid-svg-icons': {},
    '../../core/global': { getState: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
    '../../calls/CallsProvider': { useCalls: () => calls },
    '@react-navigation/native': { useFocusEffect: (callback) => react.useEffect(() => {
      focusBody = callback; focusCleanup = callback(); return () => focusCleanup?.();
    }, [callback]) },
  }, { requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; } }).default, {
    message: options.message ?? 'Hello world', onSend: () => events.sends++, onSelectGif: () => events.gifs++,
    setMessage(text) { events.edits.push(text); h.setProps({ message: text }); }, ...options.props,
  });
  const input = () => nodes(h.render(), (node) => node.type === 'TextInput')[0].props;
  const picker = () => nodes(h.render(), (node) => node.type === 'EmojiPicker')[0].props;
  input().ref.current = { focus: () => events.focus++, setNativeProps: ({ selection }) => events.cursors.push(selection) };
  const button = (label) => nodes(h.render(), (node) => node.props.accessibilityLabel === label)[0];
  return { ...h, state, calls, events, input, picker, button,
    openMenu() { button('Adjuntar archivo').props.onPress(); h.render(); },
    open() { this.openMenu(); button('Elegir emoji').props.onPress(); return h.render(); },
    select(start, end = start) { input().onSelectionChange({ nativeEvent: { selection: { start, end } } }); h.render(); },
    flushFocus() { frames.splice(0).forEach((callback) => callback()); return h.render(); },
    blur() { focusCleanup?.(); return h.render(); },
    refocus() { focusCleanup = focusBody(); return h.render(); },
    change(next) { const previous = { ...state }; Object.assign(state, next); listeners.forEach((listener) => listener(state, previous)); return h.render(); },
    newLogin() { authGeneration++; return this.change({ user: { username: 'other' } }); },
  };
}

test('emoji insertion honors UTF-16 selection and preserves complete surrogate pairs and compound presets', () => {
  const insert = data.insertEmojiAtSelection;
  assert.equal(insert('Hello world', '😀', { start: 6, end: 6 }).message, 'Hello 😀world');
  assert.equal(insert('Hello world', '❤️', { start: 6, end: 11 }).message, 'Hello ❤️');
  assert.equal(insert('A😀B', '👍🏽', { start: 2, end: 2 }).message, 'A😀👍🏽B');
  assert.equal(insert('A😀B', '🇭🇳', { start: 2, end: 3 }).message, 'A🇭🇳B');
  const family = '👨‍👩‍👧‍👦';
  const result = insert('A B', family, { start: 1, end: 1 });
  assert.equal(result.message, `A${family} B`);
  assert.equal(result.selection.start, 1 + family.length);
  assert.equal(result.selection.end, result.selection.start);
  assert.equal(insert('Text', '✨', { start: 500, end: -1 }).message, '✨');
  assert.equal(insert('Text', '😀').message, 'Text😀');
  for (const helper of [data, load('src/components/Message/emojiData.js', {}, { Intl: {} }),
    load('src/components/Message/emojiData.js', {}, { Intl: { Segmenter() { throw new Error('missing segmentation data'); } } })]) {
    for (const cluster of ['👨‍👩‍👧‍👦', '👍🏽', '🇭🇳', '❤️', 'e\u0301']) {
      const inside = helper.insertEmojiAtSelection(`A${cluster}B`, '😀', { start: 2, end: 2 });
      assert.equal(inside.message, `A${cluster}😀B`, 'an insertion inside a cluster follows the complete existing symbol');
    }
  }
});

test('choosing an emoji updates the controlled draft at the cursor, restores focus and never sends automatically', () => {
  const h = inputHarness(); h.select(6); h.open();
  assert.equal(h.picker().visible, true);
  assert.equal(h.events.edits.length, 0);
  const staleChoice = h.picker().onSelect;
  staleChoice('😀'); staleChoice('😀'); h.render();
  assert.deepEqual(h.events.edits, ['Hello 😀world']);
  assert.equal(h.input().value, 'Hello 😀world');
  assert.equal(h.picker().visible, false);
  assert.equal(h.events.sends, 0);
  h.flushFocus();
  assert.equal(h.events.focus, 1);
  assert.equal(h.events.cursors.at(-1).start, 8);
  h.input().onChangeText('Edited normally');
  assert.deepEqual(h.events.edits, ['Hello 😀world', 'Edited normally']);
});

test('cancelling emojis preserves the draft and selection, and iOS restores focus only after dismissal', () => {
  const h = inputHarness({ platform: 'ios' }); h.select(1, 5); h.open();
  h.picker().onClose(); h.render();
  assert.equal(h.input().value, 'Hello world');
  assert.equal(h.events.edits.length, 0);
  assert.equal(h.events.focus, 0);
  h.picker().onDismiss(); h.picker().onDismiss();
  assert.equal(h.events.focus, 1);
  assert.equal(h.events.cursors.at(-1).start, 1);
  assert.equal(h.events.cursors.at(-1).end, 5);
});

test('old emoji choices cannot edit a reopened picker from another conversation, revision or login session', () => {
  for (const change of ['thread', 'revision', 'account', 'blur']) {
    const h = inputHarness(); h.open(); const old = h.picker();
    if (change === 'thread') h.change({ messagesConnectionId: 2, messagesUsername: 'another' });
    else if (change === 'revision') h.change({ conversationHistory: { 1: { revision: 2 } } });
    else if (change === 'account') h.newLogin();
    else h.blur();
    assert.equal(h.picker().visible, false, change);
    if (change === 'blur') h.refocus();
    h.open(); assert.equal(h.picker().visible, true, change);
    old.onSelect('😢'); old.onClose(); h.render();
    assert.equal(h.events.edits.length, 0, change);
    assert.equal(h.picker().visible, true, 'old close cannot dismiss the new picker');
    h.picker().onSelect('👍'); h.render();
    assert.equal(h.events.edits.length, 1, change);
    h.unmount();
  }
});

test('recording, upload and call changes close emojis without blocking ordinary text during a call', () => {
  for (const block of ['upload', 'recording', 'call']) {
    const h = inputHarness(); h.open(); const stale = h.picker().onSelect;
    if (block === 'upload') h.setProps({ disabled: true });
    else if (block === 'recording') h.setProps({ isRecording: true });
    else { h.calls.call = { id: 'call', status: 'ringing' }; h.render(); }
    stale('😀'); h.flushFocus();
    assert.equal(h.picker().visible, false, block);
    assert.equal(h.events.edits.length, 0, block);
    assert.equal(h.events.focus, 0, block);
    if (block === 'call') {
      assert.equal(h.input().editable, true);
      h.input().onChangeText('Still able to type');
      assert.equal(h.input().value, 'Still able to type');
    }
  }
});

test('a queued focus restoration and delayed iOS dismissal cannot focus a changed session', () => {
  for (const platform of ['web', 'ios']) {
    const h = inputHarness({ platform }); h.open(); h.picker().onSelect('❤️'); h.render();
    h.newLogin();
    if (platform === 'ios') h.picker().onDismiss(); else h.flushFocus();
    assert.equal(h.events.focus, 0, platform);
  }
  const h = inputHarness(); h.open(); h.picker().onSelect('😀'); h.unmount(); h.flushFocus();
  assert.equal(h.events.focus, 0);
});

test('GIF action invokes only its explicit callback and keeps the text draft and send action untouched', () => {
  const h = inputHarness(); h.openMenu();
  const gif = h.button('Enviar GIF');
  assert.equal(gif.props.accessibilityRole, 'button');
  assert.equal(h.events.gifs, 0);
  gif.props.onPress(); h.render();
  assert.equal(h.events.gifs, 1);
  assert.equal(h.input().value, 'Hello world');
  assert.equal(h.events.sends, 0);
  assert.equal(h.events.edits.length, 0);
  h.setProps({ disabled: true }); h.openMenu();
  gif.props.onPress();
  assert.equal(h.events.gifs, 1);
});

test('emoji categories expose accessible choices, explicit selection and cancel/back controls without network or automatic insertion', () => {
  const selected = [], closes = [];
  const h = renderer((react) => load('src/components/Message/EmojiPicker.jsx', { react, 'react-native': native(), './emojiData': data }).default,
    { visible: true, onSelect: (emoji) => selected.push(emoji), onClose: () => closes.push(true) });
  const button = (label) => nodes(h.render(), (node) => node.props.accessibilityLabel === label)[0];
  assert.deepEqual(selected, []);
  button('Emojis: Más').props.onPress(); h.render();
  assert.equal(button('Emojis: Más').props['aria-selected'], true);
  button('Insertar emoji: Familia').props.onPress();
  assert.deepEqual(selected, ['👨‍👩‍👧‍👦']);
  button('Cerrar selector de emojis').props.onPress();
  nodes(h.render(), (node) => node.type === 'Modal')[0].props.onRequestClose();
  assert.equal(closes.length, 2);
  h.setProps({ disabled: true });
  button('Insertar emoji: Familia').props.onPress(); button('Cerrar selector de emojis').props.onPress();
  assert.equal(selected.length, 1);
  assert.equal(closes.length, 2);
});
