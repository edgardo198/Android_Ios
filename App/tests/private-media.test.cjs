const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function load(relativePath, mocks = {}, globals = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, Promise, Blob, FormData, setTimeout, clearTimeout,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      return mocks[name];
    }, ...globals,
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

const baseURL = 'https://api.chat.test';
const mediaPath = '/chat/messages/42/media/image/';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options = {}) {
  let now = 100000;
  let state = { authenticated: true, user: { username: 'Alice' } };
  const listeners = [];
  const calls = [];
  const useGlobal = (selector) => selector(state);
  useGlobal.getState = () => state;
  useGlobal.subscribe = (listener) => { listeners.push(listener); return () => {}; };
  const api = {
    resolveMediaUrl(source) {
      if (!source) return null;
      if (/^(file:|content:|blob:|data:)/i.test(source)) return source;
      return new URL(source, `${baseURL}/`).href;
    },
    getApiBaseUrl: async () => options.basePromise ? options.basePromise : baseURL,
    async post(endpoint) {
      calls.push(endpoint);
      if (options.post) return options.post(endpoint, calls.length);
      return { data: { url: `${endpoint.replace(/access\/$/, '')}?ticket=ticket-${state.user.username}-${calls.length}`, expiresIn: 900 } };
    },
  };
  const helpers = load('src/core/privateMedia.js', { './api': { ...api, default: api, __esModule: true }, './global': useGlobal }, {
    Date: class ClockDate extends Date { static now() { return now; } },
  });
  return {
    helpers, api, calls, useGlobal,
    setState(next) { state = { ...state, ...next }; listeners.forEach((listener) => listener(state)); },
    advance(milliseconds) { now += milliseconds; },
  };
}

test('only exact protected paths on the API origin acquire a ticket; local previews and external URLs bypass it', async () => {
  const h = harness();
  for (const source of ['file:///photo.png', 'content://video/1', 'blob:local-audio', 'data:image/png;base64,AA',
    'https://foreign.test/chat/messages/42/media/image/', 'https://api.chat.test/media/public-avatar.jpg',
    '/chat/messages/0/media/image/', '/chat/messages/42/media/images/', '/chat/messages/42/media/image/access/']) {
    assert.equal(h.helpers.isPrivateMediaSource(source), false, source);
    assert.equal(await h.helpers.getMediaSource(source), h.api.resolveMediaUrl(source));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.helpers.isPrivateMediaSource(mediaPath), true);
  assert.equal(h.helpers.isPrivateMediaSource(`${baseURL}${mediaPath}`), true);
  await h.helpers.getMediaSource(mediaPath);
  assert.equal(h.calls[0], `${mediaPath}access/`);
});

test('ticket acquisition is single flight, caches by stable source and refreshes 30 seconds before expiry', async () => {
  const h = harness();
  const results = await Promise.all([h.helpers.getMediaSource(mediaPath), h.helpers.getMediaSource(`${baseURL}${mediaPath}`)]);
  assert.equal(h.calls.length, 1);
  assert.equal(results[0], results[1]);
  h.advance(869000);
  assert.equal(await h.helpers.getMediaSource(mediaPath), results[0]);
  h.advance(2000);
  assert.notEqual(await h.helpers.getMediaSource(mediaPath), results[0]);
  assert.equal(h.calls.length, 2);
  assert.notEqual(await h.helpers.getMediaSource(mediaPath, { forceRefresh: true }), results[0]);
  assert.equal(h.calls.length, 3);
  assert.equal(h.helpers.mediaCacheIdentity(mediaPath), h.helpers.mediaCacheIdentity(`${baseURL}${mediaPath}?ticket=ignored`));
});

test('expiry uses request start rather than completion or the server clock', async () => {
  const pending = deferred();
  const h = harness({ post: () => pending.promise });
  const request = h.helpers.getMediaSource(mediaPath);
  await flush();
  h.advance(50000);
  pending.resolve({ data: { url: `${mediaPath}?ticket=slow`, expiresIn: 60, expiresAt: '2099-01-01T00:00:00Z' } });
  assert.match(await request, /ticket=slow/);
  await h.helpers.getMediaSource(mediaPath);
  assert.equal(h.calls.length, 2);
});

test('accounts are case-sensitive and logout invalidates tickets even when the same user logs in again', async () => {
  const h = harness();
  const first = await h.helpers.getMediaSource(mediaPath);
  const originalIdentity = h.helpers.mediaCacheIdentity(mediaPath);
  h.setState({ user: { username: 'alice' } });
  assert.notEqual(await h.helpers.getMediaSource(mediaPath), first);
  assert.notEqual(h.helpers.mediaCacheIdentity(mediaPath), originalIdentity);
  h.setState({ authenticated: false });
  await assert.rejects(h.helpers.getMediaSource(mediaPath), { code: 'SESSION_CHANGED' });
  h.setState({ authenticated: true, user: { username: 'Alice' } });
  assert.notEqual(await h.helpers.getMediaSource(mediaPath), first);
  assert.equal(h.calls.length, 3);
});

test('a ticket resolved after logout never publishes or populates another account cache', async () => {
  const pending = deferred();
  const h = harness({ post: (_endpoint, count) => count === 1 ? pending.promise : { data: { url: `${mediaPath}?ticket=new-account`, expiresIn: 900 } } });
  const first = h.helpers.getMediaSource(mediaPath);
  await flush();
  h.setState({ user: { username: 'Bob' } });
  pending.resolve({ data: { url: `${mediaPath}?ticket=old-account`, expiresIn: 900 } });
  await assert.rejects(first, { code: 'SESSION_CHANGED' });
  assert.match(await h.helpers.getMediaSource(mediaPath), /ticket=new-account/);
  assert.equal(h.calls.length, 2);
});

test('changing account during API base discovery prevents the authorization POST', async () => {
  const pending = deferred();
  const h = harness({ basePromise: pending.promise });
  const request = h.helpers.getMediaSource(mediaPath);
  h.setState({ authenticated: false });
  pending.resolve(baseURL);
  await assert.rejects(request, { code: 'SESSION_CHANGED' });
  assert.equal(h.calls.length, 0);
});

test('returned URLs reject foreign origins, paths, credentials, permanent tokens and invalid TTLs', async () => {
  for (const data of [
    { url: `https://evil.test${mediaPath}?ticket=one`, expiresIn: 900 },
    { url: '/chat/messages/43/media/image/?ticket=one', expiresIn: 900 },
    { url: `https://user:password@api.chat.test${mediaPath}?ticket=one`, expiresIn: 900 },
    { url: `${mediaPath}?ticket=one&access=jwt`, expiresIn: 900 },
    { url: `${mediaPath}?ticket=one#fragment`, expiresIn: 900 },
    { url: mediaPath, expiresIn: 900 },
    { url: `${mediaPath}?ticket=one`, expiresIn: 0 },
    { url: `${mediaPath}?ticket=one`, expiresIn: 'invalid' },
  ]) {
    const h = harness({ post: async () => ({ data }) });
    await assert.rejects(h.helpers.getMediaSource(mediaPath));
  }
});

function downloadHarness(platform = 'android', options = {}) {
  const h = harness();
  const files = new Map();
  const calls = { downloads: [], moves: [], creates: [], fetches: [], clicks: 0 };
  const fileSystem = {
    cacheDirectory: 'file:///cache/',
    async getInfoAsync(uri) { return files.has(uri) ? { exists: true, size: files.get(uri) } : { exists: false }; },
    async downloadAsync(url, uri) {
      calls.downloads.push({ url, uri }); files.set(uri, 12);
      if (options.download) return options.download(url, uri, calls.downloads.length);
      return { status: options.expireOnce && calls.downloads.length === 1 ? 403 : 200, uri };
    },
    async moveAsync({ from, to }) { calls.moves.push(to); files.set(to, files.get(from)); files.delete(from); },
    async deleteAsync(uri) { files.delete(uri); },
  };
  const metadata = load('src/components/Message/mediaMetadata.js');
  const helpers = load('src/components/Message/mediaFiles.js', {
    'react-native': { Platform: { OS: platform, Version: 35 } },
    'expo-file-system/legacy': fileSystem,
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, async digestStringAsync(algorithm, value) {
      assert.equal(algorithm, 'SHA-256');
      return require('node:crypto').createHash('sha256').update(value).digest('hex');
    } },
    'expo-media-library': { Asset: { async create(uri) { calls.creates.push(uri); } } },
    '../../core/api': h.api, '../../core/privateMedia': h.helpers, './mediaMetadata': metadata,
  }, {
    async fetch(url, config) {
      calls.fetches.push({ url, config });
      return { ok: !(options.expireOnce && calls.fetches.length === 1), status: options.expireOnce && calls.fetches.length === 1 ? 401 : 200,
        async blob() { return new Blob(['private image']); } };
    },
    URL: { createObjectURL: () => 'blob:save', revokeObjectURL() {} },
    document: { body: { appendChild() {} }, createElement: () => ({ click() { calls.clicks += 1; }, remove() {} }) },
    setTimeout() {},
  });
  return { ...h, files, downloadCalls: calls, downloadHelpers: helpers };
}

test('native saving refreshes an expired download ticket and caches under account plus stable path', async () => {
  const h = downloadHarness('android', { expireOnce: true });
  await h.downloadHelpers.saveMediaToGallery(mediaPath, 'private.png', 'image');
  assert.equal(h.calls.length, 2);
  assert.equal(h.downloadCalls.downloads.length, 2);
  assert.match(h.downloadCalls.downloads[0].url, /ticket=/);
  assert.notEqual(h.downloadCalls.downloads[0].url, h.downloadCalls.downloads[1].url);
  const firstFile = h.downloadCalls.creates[0];
  assert.match(firstFile, /chat-private-[a-f0-9]{64}\.png$/);
  await h.downloadHelpers.saveMediaToGallery(mediaPath, 'private.png', 'image');
  assert.equal(h.downloadCalls.downloads.length, 2);
  assert.equal(h.downloadCalls.creates[1], firstFile);
  h.setState({ user: { username: 'Bob' } });
  await h.downloadHelpers.saveMediaToGallery(mediaPath, 'private.png', 'image');
  assert.notEqual(h.downloadCalls.creates[2], firstFile);
});

test('logout during a native download prevents cache publication and gallery creation', async () => {
  const pending = deferred();
  const h = downloadHarness('android', { download: () => pending.promise });
  const saving = h.downloadHelpers.saveMediaToGallery(mediaPath, 'private.png', 'image');
  await flush();
  h.setState({ authenticated: false });
  pending.resolve({ status: 200 });
  await assert.rejects(saving, { code: 'SESSION_CHANGED' });
  assert.equal(h.downloadCalls.moves.length, 0);
  assert.equal(h.downloadCalls.creates.length, 0);
  assert.equal(h.files.size, 0);
});

test('web gallery retries expired links and fetches only ticket URLs without JWT headers', async () => {
  const h = downloadHarness('web', { expireOnce: true });
  await h.downloadHelpers.saveMediaToGallery(mediaPath, 'private.png', 'image');
  assert.equal(h.calls.length, 2);
  assert.equal(h.downloadCalls.fetches.length, 2);
  assert.equal(h.downloadCalls.clicks, 1);
  assert.equal(h.downloadCalls.fetches.every((call) => call.url.includes('?ticket=') && call.config === undefined), true);
});

function sourceHookHarness(context, initialSource) {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let source = initialSource;
  const react = {
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
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
        slots[index] = { value: callback, dependencies };
      }
      return slots[index].value;
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
  const useSource = load('src/core/usePrivateMediaSource.js', {
    react, './global': context.useGlobal, './api': context.api, './privateMedia': context.helpers,
  }).default;
  const render = (runEffects = true) => {
    let value;
    let attempts = 0;
    do {
      assert.ok(attempts++ < 20);
      cursor = 0; dirty = false; effects = [];
      value = useSource(source);
      if (runEffects) effects.forEach((effect) => effect());
    } while (runEffects && dirty);
    return value;
  };
  return { render, setSource(next) { source = next; }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}

test('the hook hides old account URLs in the render before effect cleanup and then resolves the current account', async () => {
  const context = harness();
  const h = sourceHookHarness(context, mediaPath);
  h.render(); await flush();
  assert.match(h.render().uri, /ticket-Alice/);
  context.setState({ user: { username: 'Bob' } });
  assert.equal(h.render(false).uri, null);
  h.render(); await flush();
  assert.match(h.render().uri, /ticket-Bob/);
  assert.equal(context.calls.length, 2);
});

test('batched logout and login for the same account invalidate the hook source through a session epoch', async () => {
  const context = harness();
  const h = sourceHookHarness(context, mediaPath);
  h.render(); await flush();
  const original = h.render().uri;
  context.setState({ authenticated: false });
  context.setState({ authenticated: true });
  assert.equal(h.render(false).uri, null);
  h.render(); await flush();
  assert.notEqual(h.render().uri, original);
  assert.equal(context.calls.length, 2);
});

test('switching to a local preview prevents a delayed remote source from replacing it', async () => {
  const pending = deferred();
  const context = harness({ post: () => pending.promise });
  const h = sourceHookHarness(context, mediaPath);
  h.render(); await flush();
  h.setSource('file:///selected.png');
  assert.equal(h.render(false).uri, 'file:///selected.png');
  pending.resolve({ data: { url: `${mediaPath}?ticket=old-source`, expiresIn: 900 } });
  await flush();
  assert.equal(h.render().uri, 'file:///selected.png');
  assert.equal(context.calls.length, 1);
});

test('private authorization failure exposes an error and refresh retries without leaking a bare protected URL', async () => {
  const context = harness({ post: (_endpoint, count) => {
    if (count === 1) throw Object.assign(new Error('Request failed'), { response: { status: 403 } });
    return { data: { url: `${mediaPath}?ticket=allowed`, expiresIn: 900 } };
  } });
  const h = sourceHookHarness(context, mediaPath);
  h.render(); await flush();
  const failed = h.render();
  assert.equal(failed.uri, null);
  assert.equal(failed.loading, false);
  assert.equal(failed.error, 'No tienes acceso a este archivo.');
  await failed.reload();
  assert.match(h.render().uri, /ticket=allowed/);
  h.unmount();
});

test('an image load failure refreshes its ticket once, then stops instead of looping', async () => {
  const context = harness();
  const h = sourceHookHarness(context, mediaPath);
  h.render(); await flush();
  const original = h.render().uri;
  await h.render().onLoadError(original);
  const recovered = h.render();
  assert.notEqual(recovered.uri, original);
  assert.equal(context.calls.length, 2);
  await recovered.onLoadError(original); // A late old-image event must be ignored.
  assert.equal(h.render().error, null);
  await recovered.onLoadError(recovered.uri);
  assert.equal(context.calls.length, 2);
  assert.match(h.render().error, /conexión/);
  await h.render().reload();
  assert.equal(context.calls.length, 3);
  assert.equal(h.render().error, null);
  h.unmount();
});

test('an old account image failure cannot refresh with the next account credentials', async () => {
  const context = harness();
  const h = sourceHookHarness(context, mediaPath);
  h.render(); await flush();
  const previous = h.render();
  context.setState({ user: { username: 'Bob' } });
  h.render(false);
  await previous.onLoadError(previous.uri);
  assert.equal(context.calls.length, 1);
  h.render(); await flush();
  assert.match(h.render().uri, /ticket-Bob/);
  h.unmount();
});

test('missing bytes are distinguished from permission errors and unrelated 404 responses', async () => {
  const context = harness({ post: async () => {
    throw Object.assign(new Error('Not found'), { response: { status: 404, data: { code: 'media_missing' } } });
  } });
  const h = sourceHookHarness(context, mediaPath);
  h.render(); await flush();
  assert.equal(h.render().uri, null);
  assert.equal(h.render().unavailable, true);
  assert.match(h.render().error, /envíen de nuevo/);
  assert.equal(context.helpers.mediaSourceError({ response: { status: 403, data: { code: 'media_missing' } } }).unavailable, false);
  assert.equal(context.helpers.mediaSourceError({ response: { status: 404 } }).unavailable, false);
  h.unmount();
});
