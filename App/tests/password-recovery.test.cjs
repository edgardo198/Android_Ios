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
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }], require('@babel/plugin-transform-modules-commonjs')],
  }).code);
  const module = { exports: {} };
  vm.runInNewContext(compiled.get(filename), { module, exports: module.exports, URL, AbortController, Promise,
    ...globals, require(name) { if (!(name in mocks)) throw new Error(`Missing mock ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const helpers = () => load('src/common/passwordRecovery.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = (status, data) => Object.assign(new Error('Request failed'), { response: { status, data } });
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

function screenHarness(name, request, options = {}) {
  let cursor = 0, effects = [], params = options.params;
  const slots = [], events = new Map();
  const calls = { requests: [], navigations: [], params: [], resets: [], emailUpdates: [], logout: 0 };
  const helper = helpers();
  const state = { initialized: true, authenticated: !!options.username, user: options.username ? { username: options.username, email: options.email || '' } : {} };
  let generation = 1;
  state.captureAuthSession = () => ({ generation, username: state.user?.username });
  state.isAuthSessionCurrent = (snapshot) => snapshot.generation === generation && snapshot.username === state.user?.username;
  state.completePasswordReset = async (username, snapshot) => {
    calls.resets.push({ username, snapshot });
    if (!state.authenticated || !state.isAuthSessionCurrent(snapshot) || state.user.username !== username) return false;
    calls.logout++; state.authenticated = false; state.user = {}; generation++; return true;
  };
  state.updateEmail = async (...args) => { calls.emailUpdates.push(args); return request(...args); };
  const store = (selector) => selector(state);
  store.getState = () => state;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect, deps) { const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) effects.push(() => {
        previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() };
      }); },
  };
  const navigation = { navigate: (...args) => calls.navigations.push(args), setParams: (value) => calls.params.push(value),
    addListener(event, callback) { events.set(event, callback); return () => events.delete(event); } };
  const mocks = {
    react, 'react-native': { Platform: { OS: options.os || 'android' }, KeyboardAvoidingView: 'KeyboardAvoidingView',
      ScrollView: 'ScrollView', Text: 'Text', View: 'View', TouchableOpacity: 'TouchableOpacity', Modal: 'Modal',
      Alert: {}, StyleSheet: { create: (value) => value } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, '../common/Input': 'Input', '../common/Button': 'Button',
    '../Styles/styles': {}, '../core/global': store, '../common/passwordRecovery': helper,
    '../common/apiError': load('src/common/apiError.js'),
    '../core/api': async (config) => { calls.requests.push(config); return request(config, calls.requests.length); },
    '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'Icon' }, '@fortawesome/free-solid-svg-icons': {},
    'expo-image-picker': {}, 'expo-image-manipulator': {}, '../common/Miniatura': 'Miniatura',
    '../components/Message/TypingAnimationSettings': 'TypingAnimationSettings',
    '../components/Message/LiveTypingSettings': 'LiveTypingSettings',
    '../notifications/BackgroundNoticeSettings': 'BackgroundNoticeSettings',
  };
  const module = load(`src/screens/${name}.jsx`, mocks, { window: options.browser });
  const Screen = name === 'Profile' ? module.ProfileEmail : module.default;
  function render() { cursor = 0; effects = []; const tree = Screen({ navigation, route: { params } }); effects.forEach((effect) => effect()); return tree; }
  render();
  return { calls, helper, state, render,
    toggleEmail() { const toggle = nodes(render(), (item) => item.type === 'TouchableOpacity' && typeof item.props.accessibilityState?.expanded === 'boolean')[0]; assert.ok(toggle, 'Recovery email disclosure'); toggle.props.onPress(); },
    setField(title, value) { const field = nodes(render(), (item) => item.type === 'Input' && item.props.title === title)[0]; assert.ok(field, title); field.props.setValue(value); },
    button(title) { const result = nodes(render(), (item) => item.type === 'Button' && (!title || item.props.title === title)); assert.equal(result.length, 1); return result[0]; },
    errors: () => nodes(render(), (item) => item.type === 'Text' && item.props.accessibilityRole === 'alert').map(text).join('\n'),
    submit() { return this.button().props.onPress(); },
    event(name) { events.get(name)?.(); },
    nextLink(link) { params = { requestId: helper.rememberPasswordResetLink(link) }; render(); },
    changeSession(username) { generation++; state.authenticated = !!username; state.user = username ? { username, email: '' } : {}; render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('recovery validates normalized email and exact passwords without trimming password spaces', () => {
  const h = helpers();
  assert.equal(h.normalizeRecoveryEmail('  Ana+chat@EXAMPLE.COM  '), 'ana+chat@example.com');
  for (const email of ['', 'a@', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) assert.ok(h.recoveryEmailError(email));
  assert.equal(h.recoveryEmailError('  Ana+chat@EXAMPLE.COM '), '');
  assert.ok(h.resetPasswordErrors('short', 'short').password);
  assert.ok(h.resetPasswordErrors('good-password', 'different').repeatedPassword);
  assert.deepEqual(plain(h.resetPasswordErrors('  password  ', '  password  ')), { password: '', repeatedPassword: '' });
});

test('only recovery routes accept valid uid/token pairs and ambiguous links are rejected', () => {
  const h = helpers();
  const expected = { uid: 'MQ', token: 'stamp-examplehash' };
  assert.deepEqual(plain(h.readPasswordResetCode(' MQ:stamp-examplehash ')), expected);
  assert.equal(h.readPasswordResetCode('MQ:token:extra'), null);
  assert.equal(h.readPasswordResetCode('MQ:has spaces'), null);
  assert.deepEqual(plain(h.readPasswordResetLink('chatlocal://reset-password?uid=MQ&token=stamp-examplehash').credentials), expected);
  assert.deepEqual(plain(h.readPasswordResetLink('https://app.test/reset-password?uid=MQ&token=stamp-examplehash', 'https://app.test').credentials), expected);
  assert.equal(h.readPasswordResetLink('https://evil.test/reset-password?uid=MQ&token=x', 'https://app.test'), null);
  assert.equal(h.readPasswordResetLink('chatlocal://profile?uid=MQ&token=x'), null);
  assert.equal(h.readPasswordResetLink('https://app.test/reset-password?uid=MQ&uid=Mg&token=x').credentials, null);
});

test('native reset deep links work with React Native HTTP-only URL host/path getters', () => {
  class NativeURL extends URL {
    get hostname() { return this.protocol === 'chatlocal:' ? '' : super.hostname; }
    get pathname() { return this.protocol === 'chatlocal:' ? '/' : super.pathname; }
    get searchParams() { if (this.search.includes('%broken')) throw new URIError('malformed native query'); return super.searchParams; }
  }
  const h = load('src/common/passwordRecovery.js', {}, { URL: NativeURL });
  assert.equal(h.readPasswordResetLink('chatlocal://reset-password?uid=MQ&token=good').credentials.token, 'good');
  assert.equal(h.readPasswordResetLink('chatlocal:///reset-password?uid=MQ&token=good').credentials.uid, 'MQ');
  assert.equal(h.readPasswordResetLink('chatlocal://reset-password?uid=%broken&token=good').credentials, null);
  assert.equal(h.readPasswordResetLink('chatlocal://reset-password/other?uid=MQ&token=good'), null);
});

test('startup queues the newest reset link until navigation/session are ready and disposal drops it', () => {
  const h = helpers(); let ready = false, cleaned = 0; const opened = [];
  const coordinator = h.createPasswordResetLinkCoordinator({ isReady: () => ready, onOpen: (value) => opened.push(value), onCleanUrl: () => cleaned++ });
  coordinator.receive('chatlocal://reset-password?uid=MQ&token=old');
  coordinator.receive('chatlocal://reset-password?uid=Mg&token=new');
  assert.equal(opened.length, 0); assert.equal(cleaned, 2);
  ready = true; assert.equal(coordinator.flush(), true); assert.equal(coordinator.flush(), false);
  assert.equal(opened[0].credentials.uid, 'Mg');
  ready = false; coordinator.receive('chatlocal://reset-password?uid=MQ&token=discard'); coordinator.dispose(); ready = true;
  assert.equal(coordinator.flush(), false); assert.equal(opened.length, 1);
});

test('web URL is scrubbed and navigation handoff contains only an opaque one-use request id', () => {
  const h = helpers(); const changes = [];
  const browser = { location: { href: 'https://app.test/reset-password?uid=MQ&token=secret#fragment' }, history: { state: { safe: true }, replaceState: (...args) => changes.push(args) } };
  assert.equal(h.clearPasswordResetUrl(browser), true); assert.equal(changes[0][2], '/reset-password');
  const id = h.rememberPasswordResetLink({ credentials: { uid: 'MQ', token: 'secret' } });
  assert.doesNotMatch(id, /MQ|secret/); assert.equal(h.takePasswordResetLink(id).credentials.token, 'secret'); assert.equal(h.takePasswordResetLink(id), null);
  assert.equal(h.recoveryExitRoute({ initialized: true, authenticated: true }), 'Home');
  assert.equal(h.recoveryExitRoute({ initialized: true, authenticated: false }), 'SignIn');
});

test('request UI requires email, prevents duplicate submits and always shows generic success', async () => {
  const pending = deferred(); const h = screenHarness('ForgotPassword', () => pending.promise);
  h.setField('Correo electrónico', 'bad'); await h.submit(); assert.equal(h.calls.requests.length, 0);
  h.setField('Correo electrónico', '  USER@EXAMPLE.COM '); const sending = h.submit(); await h.submit();
  assert.equal(h.calls.requests.length, 1); assert.equal(h.button().props.disabled, true);
  assert.deepEqual(plain(h.calls.requests[0].data), { email: 'user@example.com' });
  pending.resolve({ data: { detail: 'DO NOT DISPLAY ACCOUNT INFORMATION' } }); await sending;
  assert.match(text(h.render()), /Si existe una cuenta activa/); assert.doesNotMatch(text(h.render()), /ACCOUNT INFORMATION/);
  assert.equal(h.button().props.disabled, false);
});

test('request connection errors are visible and can be retried without logging transport details', async () => {
  const h = screenHarness('ForgotPassword', (_config, attempt) => attempt === 1 ? Promise.reject(new Error('private transport detail')) : Promise.resolve({ data: {} }));
  h.setField('Correo electrónico', 'user@example.com'); await h.submit();
  assert.match(h.errors(), /servidor/); assert.doesNotMatch(h.errors(), /private transport/);
  await h.submit(); assert.equal(h.calls.requests.length, 2); assert.match(text(h.render()), /Si existe una cuenta activa/);
});

test('request abort on blur unlocks retry and late responses cannot change the new result', async () => {
  const old = deferred(); const h = screenHarness('ForgotPassword', (_config, attempt) => attempt === 1 ? old.promise : Promise.resolve({ data: {} }));
  h.setField('Correo electrónico', 'user@example.com'); const first = h.submit(); h.event('blur');
  assert.equal(h.calls.requests[0].signal.aborted, true); assert.equal(h.button().props.disabled, false);
  await h.submit(); old.reject(new Error('late error')); await first; assert.equal(h.errors(), '');
});

function fillReset(h, password = '  new-password  ') {
  h.setField('Código de recuperación', 'MQ:stamp-examplehash'); h.setField('Nueva contraseña', password); h.setField('Repetir contraseña', password);
}

test('reset requires a complete code and matching passwords while preserving exact password bytes', async () => {
  const h = screenHarness('ResetPassword', async () => ({ data: { username: 'recovered' } }));
  h.setField('Código de recuperación', 'broken'); h.setField('Nueva contraseña', 'new-password'); h.setField('Repetir contraseña', 'different');
  await h.submit(); assert.equal(h.calls.requests.length, 0);
  fillReset(h); await h.submit();
  assert.deepEqual(plain(h.calls.requests[0].data), { uid: 'MQ', token: 'stamp-examplehash', password: '  new-password  ' });
  assert.match(text(h.render()), /Contraseña actualizada/);
});

test('expired-link feedback is readable and the user can correct the code and retry', async () => {
  const h = screenHarness('ResetPassword', (_config, attempt) => attempt === 1
    ? Promise.reject(failure(400, { detail: 'El enlace venció o no es válido. Solicita uno nuevo.' })) : Promise.resolve({ data: { username: 'recovered' } }));
  fillReset(h); await h.submit(); assert.match(h.errors(), /venció/); assert.equal(h.button().props.disabled, false);
  h.setField('Código de recuperación', 'MQ:new-valid-code'); assert.equal(h.errors(), ''); await h.submit();
  assert.equal(h.calls.requests[1].data.token, 'new-valid-code'); assert.match(text(h.render()), /Contraseña actualizada/);
});

test('own-account reset logs out through the guarded action and returns to SignIn', async () => {
  const h = screenHarness('ResetPassword', async () => ({ data: { username: 'owner' } }), { username: 'owner' });
  fillReset(h); await h.submit(); assert.equal(h.calls.logout, 1);
  h.button('Ir al inicio de sesión').props.onPress(); assert.deepEqual(plain(h.calls.navigations.at(-1)), ['SignIn']);
});

test('reset of another account never logs out the signed-in user or navigates to a guest-only route', async () => {
  const h = screenHarness('ResetPassword', async () => ({ data: { username: 'another' } }), { username: 'owner' });
  fillReset(h); await h.submit(); assert.equal(h.calls.logout, 0);
  h.button('Volver a mi cuenta').props.onPress(); assert.deepEqual(plain(h.calls.navigations.at(-1)), ['Home']);
});

test('reset response after logout/login of the same account cannot close the newer session', async () => {
  const pending = deferred(); const h = screenHarness('ResetPassword', () => pending.promise, { username: 'owner' });
  fillReset(h); const saving = h.submit(); h.changeSession(null); h.changeSession('owner'); pending.resolve({ data: { username: 'owner' } }); await saving;
  assert.equal(h.calls.logout, 0); assert.equal(h.state.authenticated, true);
});

test('a new link replaces an in-flight form, clears route secrets and ignores the old confirmation', async () => {
  const old = deferred(); const h = screenHarness('ResetPassword', () => old.promise, { username: 'owner' });
  fillReset(h); const saving = h.submit(); h.nextLink({ credentials: { uid: 'Mg', token: 'new-code' }, error: '' });
  assert.equal(h.calls.requests[0].signal.aborted, true);
  assert.equal(nodes(h.render(), (item) => item.type === 'Input' && item.props.title === 'Código de recuperación')[0].props.value, 'Mg:new-code');
  assert.equal(h.calls.params.at(-1).uid, undefined); assert.equal(h.calls.params.at(-1).token, undefined);
  old.resolve({ data: { username: 'owner' } }); await saving; assert.equal(h.calls.resets.length, 0); assert.equal(h.calls.logout, 0);
});

test('unmounted reset forms abort the request and never perform account cleanup from a late response', async () => {
  const pending = deferred(); const h = screenHarness('ResetPassword', () => pending.promise, { username: 'owner' });
  fillReset(h); const saving = h.submit(); h.unmount(); assert.equal(h.calls.requests[0].signal.aborted, true);
  pending.resolve({ data: { username: 'owner' } }); await saving; assert.equal(h.calls.resets.length, 0);
});

test('profile recovery email requires current password, normalizes email and preserves password spaces', async () => {
  const h = screenHarness('Profile', async () => ({ username: 'owner', email: 'new@example.com' }), { username: 'owner' });
  h.toggleEmail();
  h.setField('Correo electrónico', '  NEW@EXAMPLE.COM  '); await h.submit(); assert.equal(h.calls.emailUpdates.length, 0);
  h.setField('Contraseña actual', '  original-password  '); await h.submit();
  assert.deepEqual(plain(h.calls.emailUpdates[0]), ['new@example.com', '  original-password  ']);
  assert.equal(nodes(h.render(), (item) => item.type === 'Input' && item.props.title === 'Contraseña actual')[0].props.value, '');
  assert.match(text(h.render()), /Correo guardado/);
});

test('profile late email responses do not update another session or show saved feedback', async () => {
  const pending = deferred(); const h = screenHarness('Profile', () => pending.promise, { username: 'owner' });
  h.toggleEmail();
  h.setField('Correo electrónico', 'new@example.com'); h.setField('Contraseña actual', 'original-password'); const saving = h.submit();
  h.changeSession('another'); pending.resolve({ username: 'owner', email: 'new@example.com' }); await saving;
  assert.doesNotMatch(text(h.render()), /Correo guardado/);
  assert.equal(nodes(h.render(), (item) => item.type === 'Input').length, 0, 'Another account receives a closed email editor');
});

test('profile blur clears its password without allowing a duplicate save while the first request is pending', async () => {
  const pending = deferred(); const h = screenHarness('Profile', () => pending.promise, { username: 'owner' });
  h.toggleEmail();
  h.setField('Correo electrónico', 'new@example.com'); h.setField('Contraseña actual', 'original-password'); const saving = h.submit();
  h.event('blur'); assert.equal(nodes(h.render(), (item) => item.type === 'Input' && item.props.title === 'Contraseña actual')[0].props.value, '');
  assert.equal(h.button().props.disabled, true); await h.submit(); assert.equal(h.calls.emailUpdates.length, 1);
  pending.resolve({ username: 'owner', email: 'new@example.com' }); await saving; assert.doesNotMatch(text(h.render()), /Correo guardado/);
});

test('profile email starts as an own-account summary and closing the editor discards unsaved credentials', () => {
  const h = screenHarness('Profile', () => { throw new Error('Disclosure must not update email'); }, { username: 'owner', email: 'original@example.com' });
  assert.equal(nodes(h.render(), (item) => item.type === 'Input').length, 0);
  assert.match(text(h.render()), /original@example.com/);
  let toggle = nodes(h.render(), (item) => item.props.accessibilityLabel === 'Cambiar correo de recuperación')[0];
  assert.equal(toggle.props.accessibilityState.expanded, false); h.toggleEmail();
  h.setField('Correo electrónico', 'unsaved@example.com'); h.setField('Contraseña actual', 'private-password');
  h.toggleEmail(); assert.equal(nodes(h.render(), (item) => item.type === 'Input').length, 0); assert.equal(h.calls.emailUpdates.length, 0);
  h.toggleEmail();
  assert.equal(nodes(h.render(), (item) => item.type === 'Input' && item.props.title === 'Correo electrónico')[0].props.value, 'original@example.com');
  assert.equal(nodes(h.render(), (item) => item.type === 'Input' && item.props.title === 'Contraseña actual')[0].props.value, '');
});

test('closing a pending email editor clears credentials and ignores late feedback while retaining the save lock', async () => {
  const pending = deferred(); const h = screenHarness('Profile', () => pending.promise, { username: 'owner' }); h.toggleEmail();
  h.setField('Correo electrónico', 'new@example.com'); h.setField('Contraseña actual', 'original-password'); const saving = h.submit();
  h.toggleEmail(); assert.equal(nodes(h.render(), (item) => item.type === 'Input').length, 0);
  assert.match(text(h.render()), /sigue en proceso/); h.toggleEmail();
  assert.equal(nodes(h.render(), (item) => item.type === 'Input' && item.props.title === 'Contraseña actual')[0].props.value, '');
  assert.equal(h.button().props.disabled, true); await h.submit(); assert.equal(h.calls.emailUpdates.length, 1); h.toggleEmail();
  h.state.user.email = 'new@example.com'; h.render();
  pending.resolve({ username: 'owner', email: 'new@example.com' }); await saving;
  assert.equal(nodes(h.render(), (item) => item.type === 'Input').length, 0);
  assert.match(text(h.render()), /new@example.com/); assert.doesNotMatch(text(h.render()), /Correo guardado|sigue en proceso/);
  h.toggleEmail(); assert.equal(h.button().props.disabled, false);
});
