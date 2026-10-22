const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');
const axios = require('axios');

const filename = path.join(__dirname, '../src/core/api.js');
const code = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  filename, configFile: false, babelrc: false,
  plugins: [require('@babel/plugin-transform-modules-commonjs')],
}).code;
const healthy = () => ({ ok: true, json: async () => ({ status: 'ok' }) });
const never = () => new Promise(() => {});

function fakeClock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  const clock = {
    get now() { return now; },
    get pending() { return timers.size; },
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      await flush();
      const until = now + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((first, second) => first[1].at - second[1].at || first[0] - second[0])[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = until;
      await flush();
    },
    flush,
  };
  return clock;
}

function harness(options = {}) {
  const clock = fakeClock();
  const calls = { health: [], requests: [], refreshes: [] };
  const tokens = { access: 'test-access', refresh: 'test-refresh' };
  const mockAxios = {
    create(config) {
      return axios.create({ ...config, adapter: async (request) => {
        calls.requests.push({ request, at: clock.now });
        if (options.adapter) return options.adapter(request);
        return { data: {}, status: 200, headers: {}, config: request };
      } });
    },
    async post(...args) { calls.refreshes.push(args); return { data: { access: 'new-access' } }; },
  };
  const mocks = {
    axios: mockAxios,
    'expo-constants': options.constants || { expoConfig: { hostUri: '192.168.0.100:8081' } },
    'react-native': { Platform: { OS: options.web ? 'web' : 'android', select: (values) => values.android } },
    './secure': { async get() { return tokens; }, async set(_key, value) { Object.assign(tokens, value); } },
  };
  const env = options.web ? { EXPO_PUBLIC_API_SAME_ORIGIN: 'true' } : options.localDiscovery ? {}
    : { EXPO_PUBLIC_API_URL: options.url || 'https://mensajeria-pruebas.onrender.com' };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) { assert.ok(name in mocks, name); return mocks[name]; },
    process: { env }, __DEV__: options.dev || false,
    window: options.web ? { location: { origin: 'https://mensajeria-pruebas.onrender.com', hostname: 'mensajeria-pruebas.onrender.com', protocol: 'https:' } } : undefined,
    URL, AbortController, FormData, atob,
    Date: class extends Date { static now() { return clock.now; } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: async (url, config) => {
      calls.health.push({ url, config, at: clock.now });
      return options.fetch ? options.fetch(url, config, calls.health.length, clock) : healthy();
    },
  }, { filename });
  return { ...module.exports, clock, calls, tokens };
}

test('Render waits beyond the old probe timeout before sending sign-in credentials once', async () => {
  const h = harness({ fetch: (_url, _config, _attempt, clock) => new Promise((resolve) => {
    clock.setTimeout(() => resolve(healthy()), 2500);
  }) });
  const pending = h.default.post('/chat/signin/', { username: 'prueba', password: 'secret' });
  await h.clock.advance(2499);
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.calls.refreshes.length, 0);
  assert.equal(h.calls.health.length, 1);
  assert.equal(h.calls.health[0].config.method, 'GET');
  assert.equal(h.calls.health[0].config.headers, undefined);
  assert.equal(h.calls.health[0].config.body, undefined);
  await h.clock.advance(1);
  await pending;
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.calls.requests[0].at, 2500);
  assert.equal(h.calls.requests[0].request.baseURL, h.API_BASE_URL);
  assert.equal(h.calls.requests[0].request.headers.get('Authorization'), undefined);
  assert.deepEqual(JSON.parse(h.calls.requests[0].request.data), { username: 'prueba', password: 'secret' });
  assert.equal(h.clock.pending, 0);
});

test('HTML 200 and non-ready JSON do not release registration or verify another server', async () => {
  const h = harness({ fetch: (_url, _config, attempt) => {
    if (attempt === 1) return { ok: true, json: async () => { throw new SyntaxError('HTML startup page'); } };
    if (attempt === 2) return { ok: true, json: async () => ({ status: 'starting' }) };
    return healthy();
  } });
  const pending = h.default.post('/chat/signup/', { username: 'prueba', password: 'secret' });
  await h.clock.advance(1999);
  assert.equal(h.calls.requests.length, 0);
  await h.clock.advance(1);
  await pending;
  assert.equal(h.calls.health.length, 3);
  assert.equal(h.calls.requests.length, 1);
  assert.ok(h.calls.health.every((call) => call.url === `${h.API_BASE_URL}/health/`));
});

test('the ten-second health timeout includes reading JSON after successful headers', async () => {
  const h = harness({ fetch: (_url, _config, attempt) => attempt === 1 ? { ok: true, json: never } : healthy() });
  const pending = h.default.post('/chat/password-reset/request/', { email: 'test@example.com' });
  await h.clock.advance(10000);
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.calls.health[0].config.signal.aborted, true);
  await h.clock.advance(1000);
  await pending;
  assert.equal(h.calls.health.length, 2);
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.clock.pending, 0);
});

test('refresh credentials also wait for readiness before leaving the device', async () => {
  let resolveHealth;
  const h = harness({ fetch: () => new Promise((resolve) => { resolveHealth = resolve; }) });
  const pending = h.getAccessToken(true);
  await h.clock.flush();
  assert.equal(h.calls.refreshes.length, 0);
  assert.equal(h.calls.requests.length, 0);
  resolveHealth(healthy());
  assert.equal(await pending, 'new-access');
  assert.equal(h.calls.refreshes.length, 1);
  assert.equal(h.calls.refreshes[0][0], `${h.API_BASE_URL}/chat/token/refresh/`);
  assert.equal(h.calls.refreshes[0][1].refresh, 'test-refresh');
});

test('Render gives up within ninety seconds, sends no mutation or token, and permits a later retry', async () => {
  let ready = false;
  const h = harness({ fetch: () => ready ? healthy() : never() });
  const pending = h.default.post('/chat/signup/', { username: 'prueba', password: 'secret' });
  const privateRejected = assert.rejects(h.default.get('/chat/me/'), { code: 'SERVER_UNAVAILABLE' });
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, 'SERVER_UNAVAILABLE');
    assert.match(error.message, /Espera un momento/);
    assert.doesNotMatch(error.message, /secret|192\.168|timeout/i);
    return true;
  });
  await h.clock.advance(89999);
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.calls.refreshes.length, 0);
  await h.clock.advance(1);
  await Promise.all([rejected, privateRejected]);
  assert.equal(h.calls.health.length, 9);
  assert.ok(h.calls.health.every((call) => call.url === `${h.API_BASE_URL}/health/` && call.config.signal.aborted));
  assert.equal(h.clock.pending, 0);
  ready = true;
  await h.default.post('/chat/signin/', { username: 'prueba', password: 'secret' });
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.calls.health.length, 10);
});

test('immediately rejected readiness responses are paced and share the same ninety-second budget', async () => {
  const h = harness({ fetch: () => ({ ok: false, status: 503 }) });
  const rejected = assert.rejects(h.getApiBaseUrl(), { code: 'SERVER_UNAVAILABLE' });
  await h.clock.advance(90000);
  await rejected;
  assert.equal(h.calls.health.length, 90);
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.clock.pending, 0);
});

test('concurrent REST and WebSocket users share the same readiness request', async () => {
  let resolveHealth;
  const h = harness({ fetch: () => new Promise((resolve) => { resolveHealth = resolve; }) });
  const first = h.default.get('/chat/me/');
  const second = h.default.post('/chat/signin/', { username: 'prueba', password: 'secret' });
  const websocket = h.getWsBaseUrl();
  await h.clock.flush();
  assert.equal(h.calls.health.length, 1);
  assert.equal(h.calls.requests.length, 0);
  resolveHealth(healthy());
  const [, , wsUrl] = await Promise.all([first, second, websocket]);
  assert.equal(wsUrl, h.API_BASE_URL.replace('https:', 'wss:'));
  assert.equal(h.calls.requests.length, 2);
  assert.equal(h.calls.requests.find(({ request }) => request.url === '/chat/me/').request.headers.get('Authorization'), 'Bearer test-access');
});

test('verification remains cached during activity but expires after sixty seconds without use', async () => {
  const h = harness();
  await h.getApiBaseUrl();
  for (let index = 0; index < 2; index++) {
    await h.clock.advance(59999);
    await h.getApiBaseUrl();
    assert.equal(h.calls.health.length, 1);
  }
  await h.clock.advance(60000);
  await h.default.post('/chat/signin/', { username: 'prueba', password: 'secret' });
  assert.equal(h.calls.health.length, 2);
  assert.equal(h.calls.requests.length, 1);
});

test('an authentication generation changed while warming cannot send a stale private request', async () => {
  let resolveHealth;
  const h = harness({ fetch: () => new Promise((resolve) => { resolveHealth = resolve; }) });
  const pending = h.default.post('/chat/messages/media/', { type: 'image' });
  const rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' });
  await h.clock.flush();
  h.resetAuthSession();
  h.tokens.access = 'another-account-access';
  resolveHealth(healthy());
  await rejected;
  assert.equal(h.calls.requests.length, 0);
});

test('logout during warming prevents a waiting renewal from sending the old refresh token', async () => {
  let resolveHealth;
  const h = harness({ fetch: () => new Promise((resolve) => { resolveHealth = resolve; }) });
  const rejected = assert.rejects(h.getAccessToken(true), { code: 'SESSION_CHANGED' });
  await h.clock.flush();
  h.resetAuthSession();
  resolveHealth(healthy());
  await rejected;
  assert.equal(h.calls.refreshes.length, 0);
});

test('a mutation transport failure is returned without automatically replaying it', async () => {
  const h = harness({ adapter: async () => { throw Object.assign(new Error('request timeout'), { code: 'ECONNABORTED' }); } });
  await assert.rejects(h.default.post('/chat/signup/', { username: 'prueba', password: 'secret' }), { code: 'ECONNABORTED' });
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.calls.health.length, 1);
});

test('web same-origin Render receives the same readiness wait without an explicit API URL', async () => {
  const h = harness({ web: true, fetch: (_url, _config, _attempt, clock) => new Promise((resolve) => {
    clock.setTimeout(() => resolve(healthy()), 2500);
  }) });
  const pending = h.default.post('/chat/signin/', { username: 'prueba', password: 'secret' });
  await h.clock.advance(1500);
  assert.equal(h.calls.requests.length, 0);
  await h.clock.advance(1000);
  await pending;
  assert.equal(h.calls.requests.length, 1);
  assert.equal(h.calls.health.length, 1);
  assert.equal(h.calls.health[0].url, 'https://mensajeria-pruebas.onrender.com/health/');
});

test('local, HTTP, and unrelated HTTPS servers retain the fast probe and existing fallback', async () => {
  for (const url of ['http://192.168.0.100:8000', 'http://mensajeria-pruebas.onrender.com', 'https://api.example.com', 'https://app.onrender.com.example.com']) {
    const h = harness({ url, dev: true, fetch: never });
    const pending = h.default.post('/chat/signin/', { username: 'prueba', password: 'secret' });
    await h.clock.advance(1499);
    assert.equal(h.calls.requests.length, 0, url);
    await h.clock.advance(1);
    await pending;
    assert.equal(h.calls.requests.length, 1, url);
    assert.equal(h.calls.health.length, 1, url);
    assert.equal(h.calls.requests[0].request.baseURL, url);
  }
});

test('local development still discovers another candidate but verifies its JSON health response', async () => {
  const h = harness({ localDiscovery: true, dev: true, fetch: (url) => url.includes(':8001/')
    ? healthy() : { ok: true, json: async () => ({ status: 'starting' }) } });
  assert.equal(await h.getApiBaseUrl(), 'http://192.168.0.100:8001');
  assert.equal(h.calls.health.length, 3);
  assert.equal(await h.getApiBaseUrl(), 'http://192.168.0.100:8001');
  assert.equal(h.calls.health.length, 3);
});
