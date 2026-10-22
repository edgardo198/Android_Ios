const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');
const compiled = new Map();

function loadModule(relativePath, mocks = {}, consoleMock = console) {
  const filename = path.join(__dirname, '..', relativePath);
  if (!compiled.has(filename)) {
    compiled.set(filename, babel.transformSync(fs.readFileSync(filename, 'utf8'), {
      filename,
      configFile: false,
      babelrc: false,
      plugins: [
        [require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
        require('@babel/plugin-transform-modules-commonjs'),
      ],
    }).code);
  }
  const module = { exports: {} };
  vm.runInNewContext(compiled.get(filename), {
    module,
    exports: module.exports,
    console: consoleMock,
    require(name) {
      if (name in mocks) return mocks[name];
      if (name.endsWith('.ttf')) return 1;
      throw new Error(`Unexpected import: ${name}`);
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

function apiFailure(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

function findNodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => findNodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...findNodes(tree.props?.children, predicate),
  ];
}

function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (tree && typeof tree === 'object') return textContent(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

function screenHarness(screenName, request, options = {}) {
  const slots = [];
  let cursor = 0;
  const calls = { requests: [], logins: [], alerts: [], errors: [], navigations: [] };
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useLayoutEffect() {},
  };
  const normalize = loadModule('src/common/apiError.js');
  const Screen = loadModule(`src/screens/${screenName}.jsx`, {
    react,
    'react-native': {
      Platform: { OS: 'android' },
      Alert: { alert: (...args) => calls.alerts.push(args) },
      KeyboardAvoidingView: 'KeyboardAvoidingView',
      ScrollView: 'ScrollView',
      Text: 'Text',
      TouchableOpacity: 'TouchableOpacity',
      View: 'View',
    },
    'expo-font': { useFonts: () => options.fontState || [true] },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '../common/Title': 'Title',
    '../common/Button': 'Button',
    '../common/DismissKeyboardView': 'DismissKeyboardView',
    '../common/Input': 'Input',
    '../common/WebBackButton': 'WebBackButton',
    '../Styles/styles': {},
    '../core/api': async (config) => {
      calls.requests.push(config);
      return request(config, calls.requests.length);
    },
    '../common/apiError': normalize,
    '../common/passwordRecovery': loadModule('src/common/passwordRecovery.js'),
    '../core/global': (selector) => selector({ login: async (...args) => calls.logins.push(args) }),
  }, { error: (...args) => calls.errors.push(args), warn() {}, log() {} }).default;

  function render() {
    cursor = 0;
    return Screen({ navigation: { setOptions() {}, navigate: (...args) => calls.navigations.push(args) } });
  }
  function button() {
    const buttons = findNodes(render(), (node) => node.type === 'Button');
    assert.equal(buttons.length, 1);
    return buttons[0];
  }
  return {
    render,
    calls,
    normalizeApiError: normalize.normalizeApiError,
    button,
    setField(title, value) {
      const inputs = findNodes(render(), (node) => node.type === 'Input' && node.props.title === title);
      assert.equal(inputs.length, 1, `Missing input ${title}`);
      inputs[0].props.setValue(value);
    },
    errorText() {
      return findNodes(render(), (node) => node.type === 'Text' && (node.props.accessibilityRole === 'alert' || node.props.role === 'alert'))
        .map(textContent).join('\n').trim();
    },
    submit: () => button().props.onPress(),
  };
}

test('access forms remain visible and usable when the bundled font is still loading or fails', async () => {
  for (const screenName of ['Signin', 'SignUp']) for (const fontState of [[false, null], [false, new Error('font unavailable')]]) {
    const screen = screenHarness(screenName, async () => { throw new Error('must not request while rendering'); }, { fontState });
    assert.notEqual(screen.render(), null);
    screen.setField('Usuario', 'visible');
    screen.setField('Contrasena', 'usable-password');
    assert.equal(screen.button().props.disabled, false);
    const title = findNodes(screen.render(), (node) => node.type === 'Title')[0];
    assert.equal(title.props.fontLoaded, false);
    assert.equal(screen.calls.requests.length, 0);
  }
});

test('startup always shows the app title and progress while fonts are unavailable', () => {
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: (value) => ({ current: value }), useEffect() {}, useLayoutEffect() {} };
  const Splash = loadModule('src/screens/Splash.jsx', {
    react, 'react-native': { Animated: { Value: class {}, View: 'AnimatedView' }, StatusBar: 'StatusBar',
      ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (styles) => styles }, Text: 'Text' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-font': { useFonts: () => [false, new Error('font unavailable')] }, '../common/Title': 'Title',
  }).default;
  const tree = Splash({ navigation: { setOptions() {} } });
  assert.equal(findNodes(tree, (node) => node.type === 'Title')[0].props.fontLoaded, false);
  assert.equal(findNodes(tree, (node) => node.type === 'ActivityIndicator').length, 1);
  assert.match(textContent(tree), /Abriendo tu cuenta/);
  const Title = loadModule('src/common/Title.jsx', { react,
    'react-native': { Text: 'Text', StyleSheet: { create: (styles) => styles } } }).default;
  assert.equal(Title({ fontLoaded: false }).props.style[0].fontFamily, undefined);
  assert.equal(Title({ fontLoaded: false }).props.style[1], false);
  assert.equal(Title({ fontLoaded: true }).props.style[1].fontFamily, 'IBMPlexSans-Bold');
});

test('authentication errors are translated while field validation messages remain readable', () => {
  const { normalizeApiError } = loadModule('src/common/apiError.js');
  const invalid = normalizeApiError({ detail: 'Invalid credentials.' });
  assert.match(invalid, /usuario|contrase[ñn]a|credenciales/i);
  assert.doesNotMatch(invalid, /Invalid credentials/i);
  const required = normalizeApiError({ detail: 'Username and password required.' });
  assert.match(required, /usuario/i);
  assert.match(required, /contrase[ñn]a/i);
  const fields = normalizeApiError({ username: ['Este usuario ya existe.'], password: ['La contraseña es demasiado común.'] });
  assert.match(fields, /Usuario: Este usuario ya existe\./);
  assert.match(fields, /Contrase[ñn]a: La contraseña es demasiado común\./);
  assert.equal(normalizeApiError(null, 'Intenta nuevamente.'), 'Intenta nuevamente.');
});

test('sign-in 401 shows a Spanish inline error without console errors and allows correcting credentials', async () => {
  const firstRequest = deferred();
  const user = { username: 'prueba' };
  const tokens = { access: 'test-access', refresh: 'test-refresh' };
  const screen = screenHarness('Signin', (_config, attempt) => (
    attempt === 1 ? firstRequest.promise : Promise.resolve({ data: { user, tokens } })
  ));
  const originalPassword = '  password with spaces  ';
  screen.setField('Usuario', '  prueba  ');
  screen.setField('Contrasena', originalPassword);
  const submitting = screen.submit();
  assert.equal(screen.button().props.disabled, true);
  assert.equal(screen.calls.requests[0].url, '/chat/signin/');
  assert.equal(screen.calls.requests[0].data.username, 'prueba');
  assert.equal(screen.calls.requests[0].data.password, originalPassword);
  firstRequest.reject(apiFailure(401, { detail: 'Invalid credentials.' }));
  await submitting;
  assert.equal(screen.errorText(), screen.normalizeApiError({ detail: 'Invalid credentials.' }));
  assert.equal(screen.calls.errors.length, 0);
  assert.equal(screen.calls.alerts.length, 0);
  assert.equal(screen.calls.logins.length, 0);
  assert.equal(screen.button().props.disabled, false);

  const correctedPassword = '  corrected password  ';
  screen.setField('Contrasena', correctedPassword);
  assert.equal(screen.errorText(), '');
  await screen.submit();
  assert.equal(screen.calls.requests.length, 2);
  assert.equal(screen.calls.requests[1].data.password, correctedPassword);
  assert.equal(screen.calls.logins.length, 1);
  assert.equal(screen.calls.logins[0][0].username, 'prueba');
  assert.equal(screen.calls.logins[0][0].password, correctedPassword);
  assert.equal(screen.calls.logins[0][1], user);
  assert.equal(screen.calls.logins[0][2], tokens);
  assert.equal(screen.errorText(), '');
  assert.equal(screen.button().props.disabled, false);
});

test('editing the sign-in username clears the rejected-credentials message', async () => {
  const screen = screenHarness('Signin', async () => { throw apiFailure(401, { detail: 'Invalid credentials.' }); });
  screen.setField('Usuario', 'incorrecto');
  screen.setField('Contrasena', 'password');
  await screen.submit();
  assert.notEqual(screen.errorText(), '');
  screen.setField('Usuario', 'corregido');
  assert.equal(screen.errorText(), '');
});

test('an unavailable server leaves sign-in usable and displays a friendly connection message', async () => {
  const screen = screenHarness('Signin', async () => { throw new Error('ECONNREFUSED internal network details'); });
  screen.setField('Usuario', 'prueba');
  screen.setField('Contrasena', 'password');
  await screen.submit();
  assert.match(screen.errorText(), /servidor|conectar|conexi[óo]n/i);
  assert.doesNotMatch(screen.errorText(), /ECONNREFUSED|internal network/);
  assert.equal(screen.calls.logins.length, 0);
  assert.equal(screen.calls.errors.length, 0);
  assert.equal(screen.calls.alerts.length, 0);
  assert.equal(screen.button().props.disabled, false);
});

test('sign-in and registration explain server startup failures and preserve the form for a manual retry', async () => {
  for (const name of ['Signin', 'SignUp']) {
    const screen = screenHarness(name, async () => {
      throw Object.assign(new Error('INTERNAL readiness details'), { code: 'SERVER_UNAVAILABLE' });
    });
    screen.setField('Usuario', 'prueba');
    screen.setField('Contrasena', 'password-with-spaces  ');
    if (name === 'SignUp') {
      screen.setField('Nombre', 'Ana');
      screen.setField('Apellido', 'Pérez');
      screen.setField('Correo electrónico', 'ana@example.com');
      screen.setField('Confirmar Contrasena', 'password-with-spaces  ');
    }
    await screen.submit();
    assert.match(screen.errorText(), /servidor.*tardando.*Espera/);
    assert.doesNotMatch(screen.errorText(), /INTERNAL|readiness details/);
    assert.equal(screen.button().props.disabled, false);
    assert.equal(screen.calls.logins.length, 0);
    const submitted = screen.calls.requests[0].data;
    await screen.submit();
    assert.equal(screen.calls.requests.length, 2);
    assert.deepEqual(screen.calls.requests[1].data, submitted);
  }
});

test('registration validation failures are visible inline without logging or losing password spaces', async () => {
  const responseData = { username: ['Este nombre de usuario ya está en uso.'] };
  const screen = screenHarness('SignUp', async () => { throw apiFailure(400, responseData); });
  screen.setField('Usuario', '  existente  ');
  screen.setField('Nombre', '  Ana  ');
  screen.setField('Apellido', '  Pérez  ');
  screen.setField('Correo electrónico', '  ANA.PEREZ@EXAMPLE.COM  ');
  const password = '  password with spaces  ';
  screen.setField('Contrasena', password);
  screen.setField('Confirmar Contrasena', password);
  await screen.submit();
  assert.equal(screen.calls.requests.length, 1);
  assert.equal(screen.calls.requests[0].url, '/chat/signup/');
  assert.equal(screen.calls.requests[0].data.username, 'existente');
  assert.equal(screen.calls.requests[0].data.first_name, 'Ana');
  assert.equal(screen.calls.requests[0].data.last_name, 'Pérez');
  assert.equal(screen.calls.requests[0].data.email, 'ana.perez@example.com');
  assert.equal(screen.calls.requests[0].data.password, password);
  assert.equal(screen.errorText(), screen.normalizeApiError(responseData));
  assert.equal(screen.calls.logins.length, 0);
  assert.equal(screen.calls.errors.length, 0);
  assert.equal(screen.calls.alerts.length, 0);
  assert.equal(screen.button().props.disabled, false);
  screen.setField('Nombre', 'Ana María');
  assert.equal(screen.errorText(), '');
});

test('registration requires a valid recovery email and matching passwords before making a request', async () => {
  const screen = screenHarness('SignUp', async () => { throw new Error('must not request invalid forms'); });
  screen.setField('Usuario', 'new-user'); screen.setField('Nombre', 'Ana'); screen.setField('Apellido', 'Pérez');
  screen.setField('Contrasena', 'good-password'); screen.setField('Confirmar Contrasena', 'good-password');
  await screen.submit(); assert.equal(screen.calls.requests.length, 0);
  let field = findNodes(screen.render(), (node) => node.type === 'Input' && node.props.title === 'Correo electrónico')[0];
  assert.match(field.props.error, /correo/i);
  screen.setField('Correo electrónico', 'bad-address'); await screen.submit(); assert.equal(screen.calls.requests.length, 0);
  field = findNodes(screen.render(), (node) => node.type === 'Input' && node.props.title === 'Correo electrónico')[0];
  assert.match(field.props.error, /válido/);
  screen.setField('Correo electrónico', 'ana@example.com'); screen.setField('Confirmar Contrasena', 'different-password');
  await screen.submit(); assert.equal(screen.calls.requests.length, 0);
  assert.match(findNodes(screen.render(), (node) => node.type === 'Input' && node.props.title === 'Confirmar Contrasena')[0].props.error, /coinciden/);
});

test('sign-in exposes an accessible recovery action on native and web-compatible touchables', () => {
  const screen = screenHarness('Signin', async () => { throw new Error('render must not request'); });
  const action = findNodes(screen.render(), (node) => node.type === 'TouchableOpacity' && node.props.accessibilityLabel === 'Olvidé mi contraseña')[0];
  assert.ok(action); assert.equal(action.props.accessibilityRole, 'button'); action.props.onPress();
  assert.deepEqual(screen.calls.navigations, [['ForgotPassword']]);
});
