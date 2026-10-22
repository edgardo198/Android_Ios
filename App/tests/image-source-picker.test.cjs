const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');

function load(relative, mocks) {
  const filename = path.join(__dirname, '..', relative);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [['@babel/plugin-transform-react-jsx', { runtime: 'classic' }], '@babel/plugin-transform-modules-commonjs'],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
    return mocks[name];
  } }, { filename });
  return module.exports.default;
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}
function renderer(componentFactory, initialProps) {
  const slots = [];
  let cursor, dirty, tree;
  let props = initialProps;
  let effects;
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
    useCallback(callback, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) slots[index] = { dependencies, callback };
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        slots[index] = { dependencies };
        effects.push(effect);
      }
    },
  };
  const Component = componentFactory(react);
  const render = () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      cursor = 0; dirty = false; effects = [];
      tree = Component(props); effects.forEach((effect) => effect());
      if (!dirty) return tree;
    }
    throw new Error('Unexpected render loop');
  };
  render();
  return { render, setProps(next) { props = { ...props, ...next }; return render(); } };
}
const icons = { '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'FontAwesomeIcon' },
  '@fortawesome/free-solid-svg-icons': {} };
function native(platform = 'android') {
  return {
    View: 'View', Text: 'Text', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView',
    TouchableOpacity: 'TouchableOpacity', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: platform }, Keyboard: { dismiss() {} },
    useWindowDimensions: () => ({ width: 320, height: 480 }),
    StyleSheet: { create: (styles) => styles, absoluteFillObject: { position: 'absolute' } },
  };
}
function inputHarness(props = {}, platform = 'android') {
  const calls = [];
  let dismissed = 0;
  const state = { authenticated: true, user: { username: 'owner' }, messagesConnectionId: 1, messagesUsername: 'friend',
    captureAuthSession: () => ({ username: 'owner' }), isAuthSessionCurrent: () => true };
  const h = renderer((react) => load('src/components/Message/MessageInput.js', {
    react, 'react-native': { ...native(platform), Keyboard: { dismiss() { dismissed += 1; } } }, ...icons,
    '../Message/RecordingAnimation': 'RecordingAnimation', './ImageSourcePicker': 'ImageSourcePicker',
    './EmojiPicker': 'EmojiPicker', './emojiData': { insertEmojiAtSelection() {} },
    '@react-navigation/native': { useFocusEffect: (effect) => react.useEffect(effect, [effect]) },
    '../../core/global': { getState: () => state, subscribe: () => () => {} },
    '../../calls/CallsProvider': { useCalls: () => ({ call: null }) },
    '../../Styles/messageStyles': { textInput: {} },
  }), { message: 'Borrador conservado', onImage: () => calls.push('gallery'), onCamera: () => calls.push('camera'),
    guardMediaSelection: (action) => action,
    setMessage: () => calls.push('edit'), ...props });
  const button = (label) => nodes(h.render(), (node) => node.props.accessibilityLabel === label)[0];
  h.picker = () => nodes(h.render(), (node) => node.type === 'ImageSourcePicker')[0];
  h.openImages = () => {
    button('Adjuntar archivo').props.onPress(); h.render();
    button('Imágenes: galería o cámara').props.onPress(); h.render();
  };
  h.calls = calls;
  h.dismissed = () => dismissed;
  return h;
}

test('Images opens a choice without invoking permissions or a picker, and each explicit choice closes it synchronously', () => {
  for (const source of ['onGallery', 'onCamera']) {
    const h = inputHarness();
    const attach = nodes(h.render(), (node) => node.props.accessibilityLabel === 'Adjuntar archivo')[0];
    assert.equal(attach.props.accessibilityRole, 'button');
    assert.equal(attach.props.accessibilityState.disabled, false);
    assert.equal(h.picker().props.visible, false);
    h.openImages();
    assert.equal(h.picker().props.visible, true);
    assert.equal(h.dismissed(), 1);
    assert.deepEqual(h.calls, []);
    h.picker().props[source]();
    assert.deepEqual(h.calls, [source === 'onGallery' ? 'gallery' : 'camera']);
    assert.equal(h.picker().props.visible, false);
    assert.equal(nodes(h.render(), (node) => node.type === 'TextInput')[0].props.value, 'Borrador conservado');
  }
});

test('canceling image selection preserves the draft and sends nothing', () => {
  const h = inputHarness(); h.openImages();
  h.picker().props.onClose();
  assert.equal(h.picker().props.visible, false);
  assert.deepEqual(h.calls, []);
  assert.equal(nodes(h.render(), (node) => node.type === 'TextInput')[0].props.value, 'Borrador conservado');
});

test('recording and upload locks close an open choice and prevent stale buttons from starting another selection', () => {
  for (const lock of [{ disabled: true }, { isRecording: true }]) {
    const h = inputHarness(); h.openImages();
    h.setProps(lock);
    const attach = nodes(h.render(), (node) => node.props.accessibilityLabel === 'Adjuntar archivo')[0];
    assert.equal(attach.props.accessibilityState.disabled, true);
    assert.equal(h.picker().props.visible, false);
    h.picker().props.onCamera(); h.picker().props.onGallery();
    assert.deepEqual(h.calls, []);
    h.setProps({ disabled: false, isRecording: false });
    assert.equal(h.picker().props.visible, false);
  }
});

test('saving an offline text message keeps the image choice available without editing its draft', () => {
  const h = inputHarness({ isSending: true }); h.openImages();
  assert.equal(h.picker().props.visible, true);
  h.picker().props.onCamera();
  assert.deepEqual(h.calls, ['camera']);
  assert.equal(nodes(h.render(), (node) => node.type === 'TextInput')[0].props.editable, true);
});

test('iOS waits for modal dismissal before presenting its picker and a changed recording/upload lock cancels that action', () => {
  for (const source of ['onGallery', 'onCamera']) {
    const h = inputHarness({}, 'ios'); h.openImages();
    h.picker().props[source]();
    assert.deepEqual(h.calls, []);
    assert.equal(h.picker().props.visible, false);
    h.picker().props.onDismiss(); h.picker().props.onDismiss();
    assert.deepEqual(h.calls, [source === 'onGallery' ? 'gallery' : 'camera']);
  }
  const locked = inputHarness({}, 'ios'); locked.openImages();
  locked.picker().props.onCamera(); locked.setProps({ disabled: true });
  locked.picker().props.onDismiss();
  assert.deepEqual(locked.calls, []);
});

test('iOS captures a guarded selection at the gesture and a context change before modal dismissal prevents opening it', () => {
  let revision = 2;
  let captured = 0;
  const h = inputHarness({ guardMediaSelection(action) {
    captured += 1;
    const expected = revision;
    return () => expected === revision ? action() : false;
  } }, 'ios');
  h.openImages(); h.picker().props.onCamera();
  assert.equal(captured, 1); assert.deepEqual(h.calls, []);
  revision = 3;
  h.picker().props.onDismiss();
  assert.deepEqual(h.calls, []);
  const missingGuard = inputHarness({ guardMediaSelection: undefined }, 'ios');
  missingGuard.openImages(); missingGuard.picker().props.onCamera(); missingGuard.picker().props.onDismiss();
  assert.deepEqual(missingGuard.calls, []);
});

function pickerHarness(platform, attributes = {}) {
  const calls = [];
  const h = renderer((react) => load('src/components/Message/ImageSourcePicker.js', {
    react, 'react-native': native(platform), ...icons,
  }), { visible: true, onGallery: () => calls.push('gallery'), onCamera: () => calls.push('camera'),
    onClose: () => calls.push('close'), ...attributes });
  h.calls = calls;
  h.button = (label) => nodes(h.render(), (node) => node.props.accessibilityLabel === label)[0];
  return h;
}

test('native image choice exposes accessible gallery/camera buttons and back/cancel close without selection', () => {
  const h = pickerHarness('android');
  assert.deepEqual(h.calls, []);
  h.button('Elegir de la galería').props.onPress();
  h.button('Tomar foto').props.onPress();
  h.button('Cancelar selección de imagen').props.onPress();
  nodes(h.render(), (node) => node.type === 'Modal')[0].props.onRequestClose();
  assert.deepEqual(h.calls, ['gallery', 'camera', 'close', 'close']);
  assert.equal(h.button('Tomar foto').props.accessibilityRole, 'button');
});

test('disabled image choice cannot open a picker or dismiss from Android back or backdrop', () => {
  const h = pickerHarness('android', { disabled: true });
  h.button('Elegir de la galería').props.onPress(); h.button('Tomar foto').props.onPress();
  h.button('Cancelar selección de imagen').props.onPress();
  nodes(h.render(), (node) => node.type === 'Modal')[0].props.onRequestClose();
  nodes(h.render(), (node) => node.type === 'Pressable')[0].props.onPress();
  assert.deepEqual(h.calls, []);
  assert.equal(h.button('Tomar foto').props.accessibilityState.disabled, true);
});

test('web choice explains browser camera support and permits the file fallback only after an explicit gesture', () => {
  const h = pickerHarness('web');
  assert.match(text(h.render()), /En navegadores compatibles se abre la cámara/);
  assert.deepEqual(h.calls, []);
  h.button('Cámara o archivo').props.onPress();
  assert.deepEqual(h.calls, ['camera']);
  assert.equal(nodes(h.render(), (node) => node.type === 'Modal')[0].props.animationType, 'none');
  h.setProps({ visible: false });
  assert.equal(h.render(), null);
});
