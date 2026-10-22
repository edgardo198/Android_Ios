const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function loadModule(relativePath, mocks, globals = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const transformed = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    configFile: false,
    babelrc: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(transformed, {
    module,
    exports: module.exports,
    console,
    Promise,
    setTimeout,
    URL,
    Blob,
    FormData,
    require(name) {
      if (!(name in mocks)) throw new Error(`Unexpected module: ${name}`);
      return typeof mocks[name] === 'function' ? mocks[name]() : mocks[name];
    },
    ...globals,
  }, { filename });
  return module.exports;
}

const metadata = loadModule('src/components/Message/mediaMetadata.js', {});

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function galleryHarness(options = {}) {
  const platform = options.platform || { OS: 'android', Version: 35 };
  const files = new Map();
  const calls = {
    nativeLoads: 0, permissions: [], downloads: [], creates: [], info: [],
    moves: [], deleted: [], fetches: [], appended: [], clicked: [], removed: [],
    objectUrls: [], revoked: [], timers: [], deprecatedSaves: 0,
  };
  const fileSystem = {
    cacheDirectory: options.cacheDirectory === undefined ? 'file:///cache/' : options.cacheDirectory,
    async getInfoAsync(uri) {
      calls.info.push(uri);
      if (options.cacheError) throw options.cacheError;
      return files.has(uri) ? { exists: true, size: files.get(uri) } : { exists: false };
    },
    async downloadAsync(url, uri) {
      calls.downloads.push({ url, uri });
      if (options.downloadError) throw options.downloadError;
      files.set(uri, options.downloadSize === undefined ? 42 : options.downloadSize);
      return { status: options.downloadStatus === undefined ? 200 : options.downloadStatus, uri };
    },
    async moveAsync({ from, to }) {
      calls.moves.push({ from, to });
      if (options.moveError) throw options.moveError;
      files.set(to, files.get(from));
      files.delete(from);
    },
    async deleteAsync(uri) {
      calls.deleted.push(uri);
      files.delete(uri);
    },
  };
  const mediaLibrary = {
    async requestPermissionsAsync(...args) {
      calls.permissions.push(args);
      return options.permission || { granted: true, status: 'granted' };
    },
    Asset: {
      async create(uri) {
        calls.creates.push(uri);
        if (options.createError) throw options.createError;
        if (options.createPromise) await options.createPromise;
        return { id: 'saved-asset', uri };
      },
    },
    saveToLibraryAsync() {
      calls.deprecatedSaves += 1;
      throw new Error('The deprecated save API cannot be called in SDK 57.');
    },
  };
  const helpers = loadModule('src/components/Message/mediaFiles.js', {
    'react-native': { Platform: platform },
    'expo-file-system/legacy': fileSystem,
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digestStringAsync() { throw new Error('Public files do not acquire private cache identities'); } },
    'expo-media-library': () => {
      calls.nativeLoads += 1;
      if (options.nativeLoadError) throw options.nativeLoadError;
      return mediaLibrary;
    },
    '../../core/api': { resolveMediaUrl: (value) => value },
    '../../core/privateMedia': {
      captureMediaSession: () => ({ generation: 0, assertActive() {} }),
      getMediaSource: async (value) => value,
      isPrivateMediaSource: () => false,
      mediaCacheIdentity: (value) => value,
    },
    './mediaMetadata': metadata,
  }, {
    async fetch(url) {
      calls.fetches.push(url);
      if (options.fetchError) throw options.fetchError;
      return { ok: options.fetchOk !== false, async blob() { return new Blob(['download']); } };
    },
    URL: {
      createObjectURL(blob) { calls.objectUrls.push(blob); return 'blob:gallery-download'; },
      revokeObjectURL(url) { calls.revoked.push(url); },
    },
    document: {
      body: { appendChild: (element) => calls.appended.push(element) },
      createElement(tag) {
        assert.equal(tag, 'a');
        const element = {
          click() { calls.clicked.push(element); },
          remove() { calls.removed.push(element); },
        };
        return element;
      },
    },
    setTimeout(callback, delay) { calls.timers.push({ callback, delay }); },
  });
  return { helpers, calls, files };
}

test('loading media helpers and handling native local files does not load the gallery module', async () => {
  const { helpers, calls } = galleryHarness({ nativeLoadError: new Error('Native gallery module is unavailable') });
  assert.equal(calls.nativeLoads, 0);
  assert.equal(await helpers.cachedMediaFile('file:///recording.m4a', 'recording.m4a'), 'file:///recording.m4a');
  const appended = [];
  await helpers.appendUploadFile({ append: (...args) => appended.push(args) }, { uri: 'content://camera/photo' }, 'photo.jpg', 'image/jpeg');
  assert.equal(appended[0][0], 'file');
  assert.equal(calls.nativeLoads, 0);
});

test('web gallery downloads work without any native media module or device permissions', async () => {
  const { helpers, calls } = galleryHarness({
    platform: { OS: 'web' }, nativeLoadError: new Error('Native gallery module is unavailable on web'),
  });
  const source = 'https://chat.test/photo.jpg?signature=private';
  await helpers.saveMediaToGallery(source, undefined, 'image');
  assert.equal(calls.nativeLoads, 0);
  assert.deepEqual(calls.fetches, [source]);
  assert.equal(calls.permissions.length, 0);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.creates.length, 0);
  assert.equal(calls.clicked.length, 1);
  assert.equal(calls.clicked[0].href, 'blob:gallery-download');
  assert.equal(calls.clicked[0].download, 'photo.jpg');
  assert.equal(calls.appended[0], calls.clicked[0]);
  assert.equal(calls.removed[0], calls.clicked[0]);
  assert.equal(calls.objectUrls.length, 1);
  calls.timers.forEach(({ callback }) => callback());
  assert.deepEqual(calls.revoked, ['blob:gallery-download']);
});

test('a failed web download rejects without clicking a download or loading native media', async () => {
  const { helpers, calls } = galleryHarness({ platform: { OS: 'web' }, fetchOk: false });
  await assert.rejects(helpers.saveMediaToGallery('https://chat.test/photo.jpg', 'photo.jpg', 'image'), /descargar/);
  assert.equal(calls.nativeLoads, 0);
  assert.equal(calls.clicked.length, 0);
  assert.equal(calls.objectUrls.length, 0);
});

test('Android 30 and newer save photos and videos without requesting read or gallery permissions', async () => {
  for (const [version, mediaType, filename] of [[30, 'image', 'photo.jpg'], [35, 'video', 'video.mp4'], ['36', 'image', 'photo.jpg']]) {
    const { helpers, calls } = galleryHarness({
      platform: { OS: 'android', Version: version }, permission: { granted: false },
    });
    const source = `https://chat.test/${filename}`;
    await helpers.saveMediaToGallery(source, filename, mediaType);
    assert.equal(calls.permissions.length, 0);
    assert.equal(calls.downloads.length, 1);
    assert.equal(calls.moves.length, 1);
    assert.deepEqual(calls.creates, [`file:///cache/${metadata.mediaCacheFilename(source, filename)}`]);
    assert.equal(calls.deprecatedSaves, 0);
  }
});

test('saving waits for native asset creation and reuses the completed downloaded file', async () => {
  const create = deferred();
  const { helpers, calls, files } = galleryHarness({ createPromise: create.promise });
  let finished = false;
  const saving = helpers.saveMediaToGallery('https://chat.test/video.mp4', 'video.mp4', 'video').then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.creates.length, 1);
  assert.equal(files.get(calls.creates[0]), 42);
  assert.equal(finished, false);
  create.resolve();
  await saving;
  assert.equal(finished, true);
  await helpers.saveMediaToGallery('https://chat.test/video.mp4', 'video.mp4', 'video');
  assert.equal(calls.downloads.length, 1);
  assert.equal(calls.creates.length, 2);
  assert.equal(calls.creates[0], calls.creates[1]);
});

test('Android below 30 requests only write access with an empty granular read-permission list', async () => {
  const { helpers, calls } = galleryHarness({ platform: { OS: 'android', Version: 29 } });
  await helpers.saveMediaToGallery('https://chat.test/photo.jpg', 'photo.jpg', 'image');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.permissions)), [[true, []]]);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.deprecatedSaves, 0);
});

test('denied write permission on older Android prevents downloads and native asset creation', async () => {
  const { helpers, calls } = galleryHarness({
    platform: { OS: 'android', Version: 28 }, permission: { granted: false, status: 'denied' },
  });
  await assert.rejects(helpers.saveMediaToGallery('https://chat.test/photo.jpg', 'photo.jpg', 'image'), /permiso/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.permissions)), [[true, []]]);
  assert.equal(calls.info.length, 0);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.creates.length, 0);
});

test('iOS requests add-only gallery access before creating a saved asset', async () => {
  const { helpers, calls } = galleryHarness({ platform: { OS: 'ios', Version: '18.0' } });
  await helpers.saveMediaToGallery('file:///camera/photo.jpg', 'photo.jpg', 'image');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.permissions)), [[true]]);
  assert.deepEqual(calls.creates, ['file:///camera/photo.jpg']);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.deprecatedSaves, 0);
});

test('denied iOS add-only access prevents download and creation', async () => {
  const { helpers, calls } = galleryHarness({ platform: { OS: 'ios', Version: '18.0' }, permission: { granted: false } });
  await assert.rejects(helpers.saveMediaToGallery('https://chat.test/video.mp4', 'video.mp4', 'video'), /permiso/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.permissions)), [[true]]);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.creates.length, 0);
});

test('cache and download failures reject a gallery save before asset creation', async () => {
  for (const options of [
    { cacheDirectory: null },
    { cacheError: new Error('Cache unavailable') },
    { downloadError: new Error('Download interrupted') },
    { downloadStatus: 503 },
    { downloadSize: 0 },
    { moveError: new Error('Could not complete cache file') },
  ]) {
    const { helpers, calls } = galleryHarness(options);
    await assert.rejects(helpers.saveMediaToGallery('https://chat.test/video.mp4', 'video.mp4', 'video'));
    assert.equal(calls.creates.length, 0);
    assert.equal(calls.permissions.length, 0);
    assert.equal(calls.deprecatedSaves, 0);
  }
});

test('a native gallery write failure rejects instead of reporting a successful save', async () => {
  const failure = new Error('Native gallery write failed');
  const { helpers, calls } = galleryHarness({ createError: failure });
  await assert.rejects(helpers.saveMediaToGallery('https://chat.test/photo.jpg', 'photo.jpg', 'image'), (error) => error === failure);
  assert.equal(calls.downloads.length, 1);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.deprecatedSaves, 0);
});
