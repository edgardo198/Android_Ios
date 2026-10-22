const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const compiled = new Map();

function load(relativePath, mocks) {
  const filename = path.join(__dirname, '..', relativePath);
  if (!compiled.has(filename)) compiled.set(filename, babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }], require('@babel/plugin-transform-modules-commonjs')],
  }).code);
  const module = { exports: {} };
  vm.runInNewContext(compiled.get(filename), { module, exports: module.exports,
    require(name) { if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function hooksHarness() {
  const slots = [];
  let cursor = 0, effects = [];
  const updates = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        updates.push(slots[index]);
      }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  return { react, updates,
    render(component) { cursor = 0; effects = []; const tree = component(); effects.forEach((effect) => effect()); return tree; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

test('a pending initial read cannot undo a saved animation choice and unmounted listeners receive no updates', async () => {
  const read = deferred(), writes = [];
  const h = hooksHarness();
  const preference = load('src/core/typingAnimation.js', {
    react: h.react,
    '@react-native-async-storage/async-storage': {
      getItem: () => read.promise,
      async setItem(key, value) { writes.push([key, value]); },
    },
  });
  assert.equal(h.render(preference.useTypingAnimationMode), 'system');
  const saving = preference.setTypingAnimationMode('off');
  await Promise.resolve();
  assert.equal(writes.length, 0);
  read.resolve('on');
  await saving;
  assert.equal(h.render(preference.useTypingAnimationMode), 'off');
  assert.deepEqual(writes.map(([, value]) => value), ['off']);
  h.unmount();
  const updateCount = h.updates.length;
  await preference.setTypingAnimationMode('on');
  assert.equal(preference.getTypingAnimationMode(), 'on');
  assert.equal(h.updates.length, updateCount);
});

test('animation writes are serialized, failed writes preserve the last saved choice, and a retry succeeds', async () => {
  const firstWrite = deferred(), writes = [];
  const preference = load('src/core/typingAnimation.js', {
    react: hooksHarness().react,
    '@react-native-async-storage/async-storage': {
      async getItem() { return 'system'; },
      async setItem(_key, value) {
        writes.push(value);
        if (writes.length === 1) await firstWrite.promise;
        if (writes.length === 2) throw new Error('storage unavailable');
      },
    },
  });
  const first = preference.setTypingAnimationMode('on');
  const second = preference.setTypingAnimationMode('off');
  const rejected = assert.rejects(second, /No se pudo guardar/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['on']);
  firstWrite.resolve();
  await first; await rejected;
  assert.equal(preference.getTypingAnimationMode(), 'on');
  await preference.setTypingAnimationMode('off');
  assert.deepEqual(writes, ['on', 'off', 'off']);
  assert.equal(preference.getTypingAnimationMode(), 'off');
});

test('unknown saved modes and a read failure keep the system default without writing a replacement', async () => {
  for (const saved of ['invalid', new Error('unavailable')]) {
    const writes = [];
    const preference = load('src/core/typingAnimation.js', {
      react: hooksHarness().react,
      '@react-native-async-storage/async-storage': {
        async getItem() { if (saved instanceof Error) throw saved; return saved; },
        async setItem(...args) { writes.push(args); },
      },
    });
    assert.equal(await preference.loadTypingAnimationMode(), 'system');
    await assert.rejects(preference.setTypingAnimationMode('invalid'), /válida/);
    assert.equal(writes.length, 0);
  }
});

function settingsHarness(save, platform = 'android') {
  const h = hooksHarness();
  let mode = 'system';
  const calls = [];
  const Settings = load('src/components/Message/TypingAnimationSettings.jsx', {
    react: h.react,
    'react-native': { Platform: { OS: platform }, StyleSheet: { create: (value) => value }, Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View' },
    '../../core/typingAnimation': {
      useTypingAnimationMode: () => mode,
      async setTypingAnimationMode(next) { calls.push(next); await save(next); mode = next; },
    },
  }).default;
  const render = () => h.render(Settings);
  const option = (label) => {
    const found = nodes(render(), (node) => node.props.accessibilityLabel === `Animación al escribir: ${label}`);
    assert.equal(found.length, 1);
    return found[0];
  };
  return { ...h, calls, render, option };
}

test('the settings action prevents double saves, exposes a recoverable failure, and updates its selected state on retry', async () => {
  const pending = deferred();
  let attempt = 0;
  const h = settingsHarness(async () => { if (++attempt === 1) await pending.promise; });
  const press = h.option('Activada').props.onPress;
  const saving = press();
  await press();
  assert.deepEqual(h.calls, ['on']);
  assert.equal(h.option('Desactivada').props.disabled, true);
  pending.reject(new Error('disk error'));
  await saving;
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 1);
  assert.equal(h.option('Sistema').props.accessibilityState.checked, true);
  assert.equal(h.option('Activada').props.disabled, false);
  await h.option('Activada').props.onPress();
  assert.deepEqual(h.calls, ['on', 'on']);
  assert.equal(h.option('Activada').props.accessibilityState.checked, true);
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 0);
});

test('an unmounted settings screen ignores a late storage failure and cannot initiate another save', async () => {
  const pending = deferred();
  const h = settingsHarness(() => pending.promise);
  const press = h.option('Activada').props.onPress;
  const saving = press();
  h.unmount();
  const updateCount = h.updates.length;
  pending.reject(new Error('disk error'));
  await saving;
  await press();
  assert.equal(h.updates.length, updateCount);
  assert.deepEqual(h.calls, ['on']);
});

test('the installed web DOM adapter announces one selected radio and its saving, failure and retry states', async () => {
  const webStyles = Object.assign(() => ['', {}], { create: (value) => value });
  const createDOMProps = load('node_modules/react-native-web/dist/modules/createDOMProps/index.js', {
    '@babel/runtime/helpers/objectSpread2': require('@babel/runtime/helpers/objectSpread2'),
    '@babel/runtime/helpers/objectWithoutPropertiesLoose': require('@babel/runtime/helpers/objectWithoutPropertiesLoose'),
    '../AccessibilityUtil': { propsToAriaRole: (props) => props.accessibilityRole },
    '../../exports/StyleSheet': webStyles, '../warnOnce': { warnOnce() {} },
  }).default;
  const saving = deferred();
  let attempt = 0;
  const h = settingsHarness(async () => { if (++attempt === 1) await saving.promise; }, 'web');
  const renderedRadios = () => nodes(h.render(), (node) => node.props.accessibilityRole === 'radio')
    .map((node) => createDOMProps('div', node.props));
  let radios = renderedRadios();
  assert.equal(radios.filter((item) => item['aria-checked'] === true).length, 1);
  assert.equal(radios[0]['aria-checked'], true);
  const pending = h.option('Activada').props.onPress();
  radios = renderedRadios();
  assert.equal(radios.every((item) => item['aria-busy'] === true && item['aria-disabled'] === true), true);
  assert.equal(radios[0]['aria-checked'], true, 'The saved selection remains authoritative until storage succeeds');
  saving.reject(new Error('storage unavailable')); await pending;
  radios = renderedRadios();
  assert.equal(radios.filter((item) => item['aria-checked'] === true).length, 1);
  assert.equal(radios[0]['aria-checked'], true);
  assert.equal(radios.every((item) => item['aria-busy'] === false && !item['aria-disabled']), true);
  await h.option('Activada').props.onPress();
  radios = renderedRadios();
  assert.equal(radios.filter((item) => item['aria-checked'] === true).length, 1);
  assert.equal(radios[1]['aria-checked'], true);
  assert.equal(radios[0]['aria-checked'], false);
});

function liveSettingsHarness(save, initial = {}) {
  const h = hooksHarness(), listeners = new Set(), calls = [];
  let generation = 1;
  const state = { authenticated: true, outboxIdentityVerified: true, user: { username: 'owner' }, liveTypingUpdating: false,
    captureAuthSession: () => ({ generation, username: state.user.username }),
    isAuthSessionCurrent: (snapshot) => state.authenticated && snapshot?.generation === generation && snapshot.username === state.user.username,
    async updateLiveTyping(enabled) {
      calls.push(enabled); state.liveTypingUpdating = true;
      const snapshot = state.captureAuthSession();
      try {
        await save(enabled);
        if (state.isAuthSessionCurrent(snapshot)) state.user = { ...state.user, liveTypingEnabled: enabled };
      } finally { if (state.isAuthSessionCurrent(snapshot)) state.liveTypingUpdating = false; }
    }, ...initial,
  };
  const useGlobal = (selector) => selector(state);
  useGlobal.getState = () => state;
  useGlobal.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const Settings = load('src/components/Message/LiveTypingSettings.jsx', {
    react: h.react, '../../core/global': useGlobal,
    'react-native': { Platform: { OS: 'web' }, StyleSheet: { create: (value) => value }, Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View' },
  }).default;
  const render = () => h.render(() => Settings({ embedded: true }));
  const control = () => nodes(render(), (node) => node.props.accessibilityRole === 'switch')[0];
  return { ...h, state, calls, render, control,
    changeSession() {
      const previous = { ...state }; generation++;
      state.user = { username: 'other' }; state.liveTypingUpdating = false;
      listeners.forEach((listener) => listener(state, previous));
    },
  };
}

test('live sharing is off by default and its control saves only once, exposes failure and retries without changing the saved flag', async () => {
  const write = deferred(); let attempt = 0;
  const h = liveSettingsHarness(async () => { if (++attempt === 1) await write.promise; });
  assert.equal(h.control().props['aria-checked'], false);
  const press = h.control().props.onPress;
  const saving = press(); await press();
  assert.deepEqual(h.calls, [true]);
  assert.equal(h.control().props['aria-busy'], true);
  assert.equal(h.control().props.disabled, true);
  write.reject(new Error('network unavailable')); await saving;
  assert.equal(h.control().props['aria-checked'], false);
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 1);
  await h.control().props.onPress();
  assert.equal(h.control().props['aria-checked'], true);
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 0);
  await h.control().props.onPress();
  assert.deepEqual(h.calls, [true, true, false]);
  assert.equal(h.control().props['aria-checked'], false);
});

test('unverified identities cannot enable sharing and late failures after account change or unmount do not show another account an error', async () => {
  const unavailable = liveSettingsHarness(async () => {}, { outboxIdentityVerified: false });
  assert.equal(unavailable.control().props.disabled, true);
  await unavailable.control().props.onPress();
  assert.equal(unavailable.calls.length, 0);
  for (const transition of ['session', 'unmount']) {
    const pending = deferred();
    const h = liveSettingsHarness(() => pending.promise);
    const saving = h.control().props.onPress();
    if (transition === 'session') h.changeSession(); else h.unmount();
    const count = h.updates.length;
    pending.reject(new Error('late network failure')); await saving;
    assert.equal(h.updates.length, count, transition);
    assert.equal(h.state.user.liveTypingEnabled, undefined, transition);
  }
});
