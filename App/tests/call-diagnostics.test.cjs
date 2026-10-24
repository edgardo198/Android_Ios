const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function loadModule(relativePath, mocks) {
  const filename = path.join(__dirname, '..', relativePath);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
      require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, AbortController,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (tree && typeof tree === 'object') return textContent(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

function localLease(options = {}) {
  const calls = { stops: 0, microphone: [], switches: 0 };
  let stopped = false;
  const lease = {
    stream: { toURL: () => 'native-stream-url' },
    stop() { if (!stopped) { stopped = true; calls.stops += 1; } },
  };
  if (options.controls !== false) {
    lease.setMicrophoneEnabled = (enabled) => { calls.microphone.push(enabled); return true; };
    lease.switchCamera = async () => { calls.switches += 1; return options.switchGate ? await options.switchGate : true; };
  }
  return { lease, calls };
}

function harness(options = {}) {
  const slots = [];
  const appListeners = new Set();
  const storeListeners = new Set();
  let store = { authenticated: true, user: { username: 'Me' } };
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let focusCallback;
  let focusCleanup;
  const calls = { captures: [], cancellations: 0, views: 0, back: 0 };
  const fixture = options.fixture || localLease();
  const react = {
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
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))) {
        slots[index] = { callback, dependencies };
      }
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const AppState = {
    currentState: 'active',
    addEventListener(name, listener) { appListeners.add(listener); return { remove: () => appListeners.delete(listener) }; },
  };
  const useGlobal = (selector) => selector(store);
  useGlobal.getState = () => store;
  useGlobal.subscribe = (listener) => { storeListeners.add(listener); return () => storeListeners.delete(listener); };
  const native = Object.fromEntries(['ActivityIndicator', 'ScrollView', 'Text', 'TouchableOpacity', 'View'].map((name) => [name, name]));
  Object.assign(native, { AppState, StyleSheet: { create: (value) => value } });
  const adapter = {
    getNativeRtcAvailability: () => ({ available: options.available !== false, reason: options.reason }),
    getNativeRtcView() { calls.views += 1; return 'RTCView'; },
    startLocalCapture(config) { calls.captures.push(config); return options.capture ? options.capture(config) : Promise.resolve(fixture.lease); },
    cancelLocalCapture() { calls.cancellations += 1; options.foreignLease?.stop(); },
  };
  const Component = loadModule('src/calls/screens/CallDiagnosticsScreen.jsx', {
    react, 'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-navigation/native': { useFocusEffect(callback) {
      react.useEffect(() => {
        focusCallback = callback;
        focusCleanup = callback();
        return () => { focusCleanup?.(); focusCleanup = null; };
      }, [callback]);
    } },
    '../../core/global': useGlobal, '../nativeRtc': adapter,
  }).default;
  const render = () => {
    let tree;
    do {
      cursor = 0; dirty = false; effects = [];
      tree = Component({ navigation: { goBack: () => { calls.back += 1; } } });
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  };
  const button = (label) => nodes(render(), (node) => node.props.accessibilityLabel === label)[0];
  render();
  return {
    render, calls, fixture, button,
    press: (label) => button(label).props.onPress(),
    blur() { focusCleanup?.(); focusCleanup = null; render(); },
    focus() { focusCleanup = focusCallback(); render(); },
    appState(state) { AppState.currentState = state; appListeners.forEach((listener) => listener(state)); render(); },
    session(next) { const previous = store; store = { ...store, ...next }; storeListeners.forEach((listener) => listener(store, previous)); render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('unsupported Expo Go or web shows an actionable notice and never requests local devices or RTCView', async () => {
  const h = harness({ available: false, reason: 'Expo Go no incluye esta función. Abre la app instalada en Android.' });
  assert.match(textContent(h.render()), /Expo Go/);
  assert.equal(h.button('Preparar audio').props.disabled, true);
  assert.equal(h.button('Probar cámara y audio').props.disabled, true);
  assert.equal(await h.press('Preparar audio'), false);
  assert.equal(h.calls.captures.length, 0);
  assert.equal(h.calls.views, 0);
});

test('audio preparation starts only on demand, supports track disable and closes when returning to profile', async () => {
  const h = harness();
  assert.equal(h.calls.captures.length, 0);
  assert.equal(await h.press('Preparar audio'), true);
  assert.equal(h.calls.captures[0].video, false);
  assert.equal(h.calls.views, 0);
  assert.equal(nodes(h.render(), (node) => node.type === 'RTCView').length, 0);
  assert.match(textContent(h.render()), /todavía no comprueba la captura de sonido/);
  assert.match(textContent(h.render()), /Audio preparado/);
  assert.doesNotMatch(textContent(h.render()), /Micrófono activo/);
  h.press('Silenciar micrófono');
  assert.match(textContent(h.render()), /Audio deshabilitado/);
  h.press('Activar micrófono');
  assert.match(textContent(h.render()), /Audio preparado/);
  assert.deepEqual(h.fixture.calls.microphone, [false, true]);
  h.press('Volver al perfil');
  assert.equal(h.fixture.calls.stops, 1);
  assert.equal(h.calls.back, 1);
  assert.equal(h.button('Preparar audio').props.disabled, false);
  assert.match(textContent(h.render()), /están apagados/);
});

test('camera preview uses its local stream and changes mirror only after one completed camera switch', async () => {
  const changing = deferred();
  const fixture = localLease({ switchGate: changing.promise });
  const h = harness({ fixture });
  await h.press('Probar cámara y audio');
  const camera = () => nodes(h.render(), (node) => node.type === 'RTCView')[0];
  assert.equal(h.calls.captures[0].video, true);
  assert.equal(camera().props.streamURL, 'native-stream-url');
  assert.equal(camera().props.mirror, true);
  const switchCamera = h.button('Cambiar cámara').props.onPress;
  const switching = switchCamera();
  assert.equal(await switchCamera(), false);
  assert.equal(fixture.calls.switches, 1);
  assert.equal(h.button('Cambiar cámara').props.disabled, true);
  assert.equal(camera().props.mirror, true);
  changing.resolve(true);
  assert.equal(await switching, true);
  assert.equal(camera().props.mirror, false);
  h.press('Detener prueba');
  assert.equal(fixture.calls.stops, 1);
  assert.equal(camera(), undefined);
});

test('a pending device request is single flight and stopping discards and closes its late stream', async () => {
  const opening = deferred();
  const fixture = localLease();
  const h = harness({ fixture, capture: () => opening.promise });
  const start = h.button('Probar cámara y audio').props.onPress;
  const starting = start();
  assert.equal(await start(), false);
  assert.equal(h.calls.captures.length, 1);
  h.press('Detener prueba');
  assert.equal(h.calls.captures[0].signal.aborted, true);
  assert.equal(h.button('Detener prueba').props.disabled, true);
  assert.equal(await h.press('Preparar audio'), false);
  opening.resolve(fixture.lease);
  assert.equal(await starting, false);
  assert.equal(fixture.calls.stops, 1);
  assert.equal(h.calls.views, 0);
  assert.equal(h.button('Probar cámara y audio').props.disabled, false);
});

test('blur, background, logout and unmount release active streams without restarting on focus or foreground', async () => {
  for (const leave of ['blur', 'background', 'logout', 'unmount']) {
    const h = harness();
    await h.press('Probar cámara y audio');
    if (leave === 'blur') { h.blur(); h.focus(); }
    if (leave === 'background') { h.appState('background'); h.appState('active'); }
    if (leave === 'logout') h.session({ authenticated: false });
    if (leave === 'unmount') h.unmount();
    assert.equal(h.fixture.calls.stops, 1, leave);
    assert.equal(h.calls.captures.length, 1, leave);
    if (leave !== 'unmount') assert.equal(nodes(h.render(), (node) => node.type === 'RTCView').length, 0, leave);
  }
});

test('idle diagnostics cleanup leaves a capture owned by a real call untouched', () => {
  for (const leave of ['blur', 'background', 'logout', 'unmount']) {
    const foreign = localLease();
    const h = harness({ foreignLease: foreign.lease });
    if (leave === 'blur') h.blur();
    if (leave === 'background') h.appState('background');
    if (leave === 'logout') h.session({ authenticated: false });
    if (leave === 'unmount') h.unmount();
    assert.equal(foreign.calls.stops, 0, leave);
    assert.equal(h.calls.cancellations, 0, leave);
    assert.equal(h.calls.captures.length, 0, leave);
  }
});

test('late permissions cannot attach a stream after blur, background, logout, account change or unmount', async () => {
  for (const leave of ['blur', 'background', 'logout', 'account', 'unmount']) {
    const opening = deferred();
    const fixture = localLease();
    const h = harness({ fixture, capture: () => opening.promise });
    const starting = h.press('Probar cámara y audio');
    if (leave === 'blur') { h.blur(); h.focus(); }
    if (leave === 'background') { h.appState('background'); h.appState('active'); }
    if (leave === 'logout') { h.session({ authenticated: false }); h.session({ authenticated: true }); }
    if (leave === 'account') h.session({ user: { username: 'me' } });
    if (leave === 'unmount') h.unmount();
    assert.equal(h.calls.captures[0].signal.aborted, true, leave);
    opening.resolve(fixture.lease);
    assert.equal(await starting, false, leave);
    assert.equal(fixture.calls.stops, 1, leave);
    assert.equal(h.calls.views, 0, leave);
    assert.equal(h.calls.cancellations, 0, leave);
  }
});

test('a permission dialog that backgrounds the app asks for another tap without assuming permission was granted or restarting', async () => {
  const opening = deferred();
  const first = localLease();
  const second = localLease();
  let attempts = 0;
  const h = harness({ capture: () => ++attempts === 1 ? opening.promise : Promise.resolve(second.lease) });
  const starting = h.press('Probar cámara y audio');
  h.appState('background');
  h.appState('active');
  opening.resolve(first.lease);
  assert.equal(await starting, false);
  assert.equal(first.calls.stops, 1);
  assert.equal(h.calls.captures.length, 1);
  assert.match(textContent(h.render()), /La prueba se detuvo. Pulsa de nuevo para iniciarla./);
  assert.doesNotMatch(textContent(h.render()), /permisos concedidos/i);
  assert.equal(await h.press('Probar cámara y audio'), true);
  assert.equal(h.calls.captures.length, 2);
  assert.doesNotMatch(textContent(h.render()), /Pulsa de nuevo/);
});

test('permission failure appears inline, preserves an idle screen and permits another manual attempt', async () => {
  let attempts = 0;
  const fixture = localLease({ controls: false });
  const h = harness({ fixture, capture() {
    attempts += 1;
    return attempts === 1 ? Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })) : Promise.resolve(fixture.lease);
  } });
  assert.equal(await h.press('Preparar audio'), false);
  const alert = nodes(h.render(), (node) => node.props.accessibilityRole === 'alert')[0];
  assert.match(textContent(alert), /Permite el acceso al micrófono/);
  assert.equal(h.button('Preparar audio').props.disabled, false);
  assert.equal(await h.press('Preparar audio'), true);
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 0);
  assert.equal(h.button('Silenciar micrófono'), undefined);
  assert.equal(h.button('Cambiar cámara'), undefined);
});

test('native camera and microphone permission feedback identifies the device that needs access', async () => {
  for (const [code, message] of [
    ['MICROPHONE_PERMISSION_DENIED', 'Permite el acceso al micrófono en los ajustes de la aplicación para iniciar la prueba.'],
    ['CAMERA_PERMISSION_DENIED', 'Permite el acceso a la cámara en los ajustes de la aplicación para iniciar la prueba.'],
  ]) {
    const h = harness({ capture: () => Promise.reject(Object.assign(new Error(message), { code })) });
    assert.equal(await h.press('Probar cámara y audio'), false);
    const alert = nodes(h.render(), (node) => node.props.accessibilityRole === 'alert')[0];
    assert.equal(textContent(alert), message);
    assert.equal(h.calls.views, 0);
  }
});

test('a camera switch finishing after stop cannot change or report an error in the new capture', async () => {
  const switching = deferred();
  const first = localLease({ switchGate: switching.promise });
  const second = localLease();
  let count = 0;
  const h = harness({ capture: () => Promise.resolve(++count === 1 ? first.lease : second.lease) });
  await h.press('Probar cámara y audio');
  const oldSwitch = h.press('Cambiar cámara');
  h.press('Detener prueba');
  await h.press('Probar cámara y audio');
  switching.reject(new Error('Released camera'));
  assert.equal(await oldSwitch, false);
  assert.equal(nodes(h.render(), (node) => node.type === 'RTCView')[0].props.mirror, true);
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 0);
  assert.equal(h.button('Cambiar cámara').props.disabled, false);
});

test('profile exposes diagnostics and call history without starting capture or leaving the current session', () => {
  const routes = [];
  const react = { createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }),
    useState: value => [value, () => {}], useRef: value => ({current: value}), useEffect: () => {} };
  const Screen = loadModule('src/screens/Profile.jsx', {
    react,
    'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', Modal: 'Modal', ScrollView: 'ScrollView', Alert: {}, Platform: { OS: 'android' }, StyleSheet: { create: (value) => value } },
    '@fortawesome/react-native-fontawesome': {}, '@fortawesome/free-solid-svg-icons': {},
    'expo-image-picker': {}, 'expo-image-manipulator': {},
    '../components/Message/mediaFiles': { appendUploadFile() { throw new Error('Navigation must not upload files'); } },
    '../core/global': (selector) => selector({ user: { username: 'Me' } }),
    '../common/Miniatura': 'Avatar', '../Styles/styles': {},
    '../common/Input': 'Input', '../common/Button': 'Button',
    '../common/apiError': { normalizeApiError() { throw new Error('Navigation must not normalize a request error'); } },
    '../common/passwordRecovery': {
      normalizeRecoveryEmail() { throw new Error('Navigation must not submit an email'); },
      recoveryEmailError() { throw new Error('Navigation must not validate an email'); },
    },
    '../components/Message/TypingAnimationSettings': 'TypingAnimationSettings',
    '../components/Message/LiveTypingSettings': 'LiveTypingSettings',
    '../notifications/BackgroundNoticeSettings': 'BackgroundNoticeSettings',
  }).default;
  const tree = Screen({ navigation: { navigate: (route) => routes.push(route) } });
  assert.equal(tree.type, 'ScrollView');
  nodes(tree, (node) => node.props.accessibilityLabel === 'Prueba de llamadas')[0].props.onPress();
  nodes(tree, (node) => node.props.accessibilityLabel === 'Historial de llamadas')[0].props.onPress();
  assert.deepEqual(routes, ['CallDiagnostics', 'CallHistory']);
});
