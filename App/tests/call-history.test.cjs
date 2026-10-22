const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function loadModule(relative, mocks = {}) {
  const filename = path.join(__dirname, '..', relative);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }], require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, AbortController,
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock: ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate),
    ...nodes(tree.props?.ListFooterComponent, predicate), ...nodes(tree.props?.ListEmptyComponent, predicate)];
}
function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (tree && typeof tree === 'object') return textContent(tree.props?.children) + textContent(tree.props?.ListFooterComponent) + textContent(tree.props?.ListEmptyComponent);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

const presentation = loadModule('src/calls/callPresentation.js');
const apiErrors = loadModule('src/common/apiError.js');
function entry(id, overrides = {}) {
  return { id, kind: 'audio', direction: 'outgoing', peer: { username: 'friend', name: 'Contacto' },
    reason: 'ended', status: 'ended', createdAt: '2026-10-09T12:00:00Z',
    activeAt: '2026-10-09T12:00:20Z', endedAt: '2026-10-09T12:01:25Z', durationSeconds: 65, ...overrides };
}

function harness(options = {}) {
  const slots = [];
  const listeners = new Set();
  let store = { authenticated: options.authenticated !== false, user: { username: 'Me' } };
  let cursor = 0; let dirty = false; let effects = [];
  let focusCallback; let focusCleanup;
  const requests = [];
  const deletions = [];
  const callsState = { historyRevision: 0, ...options.callsState };
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
      if (!previous || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))) effects.push(() => {
        previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() };
      });
    },
  };
  const useGlobal = (selector) => selector(store);
  useGlobal.getState = () => store;
  useGlobal.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const exports = loadModule('src/calls/screens/CallHistoryScreen.jsx', {
    react,
    'react-native': { ActivityIndicator: 'ActivityIndicator', FlatList: 'FlatList', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View', StyleSheet: { create: (value) => value } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-navigation/native': { useFocusEffect(callback) {
      react.useEffect(() => { focusCallback = callback; if (options.focused !== false) focusCleanup = callback();
        return () => { focusCleanup?.(); focusCleanup = null; }; }, [callback]);
    } },
    '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'FontAwesomeIcon' },
    '@fortawesome/free-solid-svg-icons': { faPhone: 'phone', faVideo: 'video', faTrash: 'trash' },
    '../../core/api': { get(url, config) {
      const item = { url, config, username: store.user.username }; requests.push(item);
      return options.request ? options.request(item, requests.length) : Promise.resolve({ data: { results: [], nextCursor: null } });
    }, delete(url, config) {
      const item = { url, config, username: store.user.username }; deletions.push(item);
      return options.remove ? options.remove(item, deletions.length) : Promise.resolve({ data: { deletedCount: 1, callIds: null, revision: 1 } });
    } },
    '../../core/global': useGlobal, '../../common/WebBackButton': 'WebBackButton',
    '../../common/DeleteConfirmation': 'DeleteConfirmation',
    '../../common/apiError': apiErrors, '../callPresentation': presentation,
    '../CallsProvider': { useCalls: () => callsState },
  });
  const render = () => {
    let tree;
    do { cursor = 0; dirty = false; effects = []; tree = exports.default({ navigation: {} }); effects.forEach((effect) => effect()); } while (dirty);
    return tree;
  };
  render();
  return { render, requests, deletions, callsState, row: (item) => exports.CallHistoryRow({ item }),
    list: () => nodes(render(), (node) => node.type === 'FlatList')[0]?.props,
    button: (label) => nodes(render(), (node) => node.props.accessibilityLabel === label)[0],
    confirmation: () => nodes(render(), (node) => node.type === 'DeleteConfirmation')[0]?.props,
    rowButton(id) {
      const list = nodes(render(), (node) => node.type === 'FlatList')[0].props;
      const item = list.data.find((entry) => entry.id === id);
      return nodes(exports.CallHistoryRow(list.renderItem({ item }).props), (node) => node.type === 'TouchableOpacity')[0];
    },
    historyRevision(value) { callsState.historyRevision = value; return render(); },
    blur() { focusCleanup?.(); focusCleanup = null; },
    focus() { focusCleanup = focusCallback(); render(); },
    session(next, rerender = true) {
      const previous = store; store = { ...store, ...next }; listeners.forEach((listener) => listener(store, previous));
      if (rerender) render();
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('history loads only on focus or explicit refresh, with authenticated requests and no render-driven fetches', async () => {
  const response = deferred();
  const h = harness({ request: () => response.promise });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/calls/history/');
  assert.deepEqual(plain(h.requests[0].config.params), { limit: 50 });
  for (let index = 0; index < 20; index += 1) h.render();
  assert.equal(h.requests.length, 1);
  assert.equal(await h.button('Actualizar historial').props.onPress(), false);
  response.resolve({ data: { results: [entry('first')], nextCursor: null } });
  await settle();
  assert.equal(h.list().data.length, 1);
  assert.equal(h.button('Actualizar historial').props.disabled, false);
  const guest = harness({ authenticated: false });
  assert.equal(guest.requests.length, 0);
  assert.match(textContent(guest.render()), /Inicia sesión/);
  guest.session({ authenticated: true }); await settle();
  assert.equal(guest.requests.length, 1);
});

test('cursor pagination keeps previous records, deduplicates overlaps and retries the same failed page', async () => {
  const cursor = 'opaque/with+=cursor';
  let attempts = 0;
  const h = harness({ request: (request) => {
    if (!request.config.params.cursor) return Promise.resolve({ data: { results: [entry('one')], nextCursor: cursor } });
    if (++attempts === 1) return Promise.reject(new Error('Offline'));
    return Promise.resolve({ data: { results: [entry('one', { durationSeconds: 70 }), entry('two')], nextCursor: null } });
  } });
  await settle();
  assert.equal(await h.button('Cargar más llamadas').props.onPress(), false);
  assert.equal(h.list().data.length, 1);
  assert.match(textContent(h.render()), /No se pudo cargar el historial/);
  assert.equal(await h.button('Reintentar historial').props.onPress(), true);
  assert.equal(h.requests[1].config.params.cursor, cursor);
  assert.equal(h.requests[2].config.params.cursor, cursor);
  assert.deepEqual(plain(h.list().data.map((item) => item.id)), ['one', 'two']);
  assert.equal(h.list().data[0].durationSeconds, 70);
  assert.equal(h.button('Cargar más llamadas'), undefined);
});

test('logout and relogin of the same exact account discard an old response and never clear the new request', async () => {
  const old = deferred(); const fresh = deferred();
  const h = harness({ request: (request, number) => number === 1 ? old.promise : fresh.promise });
  h.session({ authenticated: false }, false);
  h.session({ authenticated: true }, false);
  assert.equal(h.requests[0].config.signal.aborted, true);
  assert.equal(h.requests.length, 2);
  old.resolve({ data: { results: [entry('old-session')], nextCursor: 'old-cursor' } });
  await settle();
  assert.equal(h.list().data.length, 0);
  assert.equal(h.button('Actualizar historial').props.disabled, true);
  fresh.resolve({ data: { results: [entry('fresh-session')], nextCursor: null } });
  await settle();
  assert.deepEqual(plain(h.list().data.map((item) => item.id)), ['fresh-session']);
});

test('account names differing only by case remain isolated and stale account errors are ignored', async () => {
  const old = deferred(); const fresh = deferred();
  const h = harness({ request: (request, number) => number === 1 ? old.promise : fresh.promise });
  h.session({ user: { username: 'me' } });
  assert.equal(h.requests[0].config.signal.aborted, true);
  assert.equal(h.requests[1].username, 'me');
  old.reject({ response: { data: { detail: 'Private old account error' } } });
  await settle();
  assert.doesNotMatch(textContent(h.render()), /Private old account/);
  fresh.resolve({ data: { results: [entry('case-sensitive')], nextCursor: null } });
  await settle();
  assert.deepEqual(plain(h.list().data.map((item) => item.id)), ['case-sensitive']);
});

test('blur and unmount abort pending requests, and a later focus starts a fresh page without a stale cursor', async () => {
  for (const leave of ['blur', 'unmount']) {
    const old = deferred(); const fresh = deferred();
    const h = harness({ request: (request, number) => number === 1 ? old.promise : fresh.promise });
    if (leave === 'blur') { h.blur(); h.focus(); } else h.unmount();
    assert.equal(h.requests[0].config.signal.aborted, true, leave);
    old.resolve({ data: { results: [entry('late')], nextCursor: 'stale-cursor' } });
    await settle();
    if (leave === 'blur') {
      assert.equal(h.list().data.length, 0);
      assert.deepEqual(plain(h.requests[1].config.params), { limit: 50 });
      fresh.resolve({ data: { results: [entry('current-focus')], nextCursor: null } });
      await settle();
      assert.deepEqual(plain(h.list().data.map((item) => item.id)), ['current-focus']);
    } else assert.equal(h.requests.length, 1);
  }
});

test('history rows show confirmed result and server duration without inventing dates or missing durations', () => {
  const h = harness({ focused: false });
  const answered = textContent(h.row(entry('video', { kind: 'video', durationSeconds: 3723 })));
  assert.match(answered, /Videollamada.*Saliente/);
  assert.match(answered, /Completada/);
  assert.match(answered, /1:02:03/);
  const missed = textContent(h.row(entry('missed', { direction: 'incoming', reason: 'missed', durationSeconds: 0 })));
  assert.match(missed, /Entrante/);
  assert.match(missed, /Perdida/);
  assert.match(missed, /00:00/);
  const invalid = textContent(h.row(entry('invalid', { endedAt: 'invalid', createdAt: null, durationSeconds: null })));
  assert.doesNotMatch(invalid, /Invalid Date|NaN|Duración/);
  assert.equal(presentation.formatCallDuration(-1), null);
});

test('bulk deletion requires confirmation, retries failures and leaves an active call untouched', async () => {
  const activeCall = { id: 'active-call', status: 'active', kind: 'audio' };
  let records = [entry('one'), entry('two')];
  const removing = deferred();
  const h = harness({ callsState: { call: activeCall },
    request: () => Promise.resolve({ data: { results: records, nextCursor: null } }),
    remove: (_request, attempt) => attempt === 1 ? Promise.reject(new Error('Offline')) : removing.promise,
  });
  await settle();
  h.button('Borrar todo el historial de llamadas').props.onPress();
  assert.equal(h.deletions.length, 0);
  assert.match(h.confirmation().message, /ambos participantes/);
  assert.match(h.confirmation().message, /en curso no se interrumpen/);
  h.confirmation().onCancel();
  assert.equal(h.confirmation(), undefined);
  assert.equal(h.deletions.length, 0);

  h.button('Borrar todo el historial de llamadas').props.onPress();
  assert.equal(await h.confirmation().onConfirm(), false);
  assert.match(h.confirmation().error, /No se pudo confirmar el borrado/);
  assert.equal(h.list().data.length, 2);
  const confirm = h.confirmation().onConfirm;
  const deleting = confirm();
  assert.equal(await confirm(), false);
  assert.equal(h.deletions.length, 2);
  assert.equal(h.deletions[1].url, '/calls/history/');
  assert.equal(h.confirmation().busy, true);
  assert.equal(h.rowButton('one').props.disabled, true);
  assert.equal(h.button('Actualizar historial').props.disabled, false);
  records = [];
  removing.resolve({ data: { deletedCount: 2, callIds: null, revision: 1 } });
  assert.equal(await deleting, true); await settle();
  assert.equal(h.confirmation(), undefined);
  assert.equal(h.list().data.length, 0);
  assert.equal(h.callsState.call, activeCall);
});

test('single deletion targets the selected call and remote history changes invalidate stale pages only while focused', async () => {
  const id = 'a710131a-0297-4a47-b1cd-862c9d4cf7d6';
  let records = [entry(id), entry('other')];
  const stale = deferred(); let gets = 0;
  const h = harness({ request: () => ++gets === 3 ? stale.promise : Promise.resolve({ data: { results: records, nextCursor: null } }),
    remove: async () => {
      records = records.filter((item) => item.id !== id);
      return { data: { deletedCount: 1, callIds: [id], revision: 1 } };
    },
  });
  await settle();
  h.rowButton(id).props.onPress();
  assert.equal(h.deletions.length, 0);
  assert.equal(await h.confirmation().onConfirm(), true); await settle();
  assert.equal(h.deletions[0].url, `/calls/history/${id}/`);
  assert.deepEqual(plain(h.list().data.map((item) => item.id)), ['other']);

  const refreshing = h.button('Actualizar historial').props.onPress();
  records = [];
  h.historyRevision(2);
  assert.equal(h.requests[2].config.signal.aborted, true);
  await settle();
  stale.resolve({ data: { results: [entry('deleted-remote')], nextCursor: 'stale' } });
  assert.equal(await refreshing, false); await settle();
  assert.equal(h.list().data.length, 0);
  for (let index = 0; index < 10; index += 1) h.render();
  assert.equal(h.requests.length, 4);
  h.blur(); h.historyRevision(3); await settle();
  assert.equal(h.requests.length, 4);
  h.focus(); await settle();
  assert.equal(h.requests.length, 5);
  assert.deepEqual(plain(h.requests[4].config.params), { limit: 50 });
});

test('a deletion completed after logout cannot clear a new session or finish its newer deletion', async () => {
  for (const outcome of ['success', 'failure']) {
    const old = deferred(); const fresh = deferred(); let gets = 0; let freshDeleted = false;
    const h = harness({ request: () => Promise.resolve({ data: { results: freshDeleted ? [] : [entry(++gets === 1 ? 'old' : 'fresh')], nextCursor: null } }),
      remove: (_request, attempt) => attempt === 1 ? old.promise : fresh.promise,
    });
    await settle();
    h.rowButton('old').props.onPress();
    const deletingOld = h.confirmation().onConfirm();
    h.session({ authenticated: false }, false); h.session({ authenticated: true }); await settle();
    assert.equal(h.deletions[0].config.signal.aborted, true, outcome);
    h.rowButton('fresh').props.onPress();
    const deletingFresh = h.confirmation().onConfirm();
    if (outcome === 'success') old.resolve({ data: { deletedCount: 1, callIds: null, revision: 1 } });
    else old.reject({ response: { data: { detail: 'Old private deletion error' } } });
    assert.equal(await deletingOld, false, outcome); await settle();
    assert.deepEqual(plain(h.list().data.map((item) => item.id)), ['fresh'], outcome);
    assert.equal(h.confirmation().busy, true, outcome);
    assert.equal(h.confirmation().error, null, outcome);
    freshDeleted = true;
    fresh.resolve({ data: { deletedCount: 1, callIds: ['fresh'], revision: 2 } });
    assert.equal(await deletingFresh, true, outcome); await settle();
    assert.equal(h.list().data.length, 0, outcome);
  }
});
