const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function loadModule(relativePath, mocks = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const transformed = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(transformed, {
    module, exports: module.exports, console, Promise, setTimeout, URL, Blob, FormData, AbortController,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}

const metadata = loadModule('src/components/Message/mediaMetadata.js');
test('media names preserve extensions, discard URL signatures and strip path traversal', () => {
  assert.equal(metadata.filenameFromUri('https://chat.test/a%20photo.PNG?token=one.mp4#part'), 'a_photo.PNG');
  assert.equal(metadata.sanitizeFilename('../../audio.m4a'), 'audio.m4a');
  assert.equal(metadata.getExtension('https://chat.test/video.MOV?download=1'), 'mov');
  assert.equal(metadata.getExtension('filename'), '');
  assert.equal(metadata.inferMimeType('video.MOV'), 'video/quicktime');
  assert.equal(metadata.inferMimeType('test.constructor'), 'application/octet-stream');
  assert.equal(metadata.replaceExtension('camera.heic', 'jpg'), 'camera.jpg');
});
test('cache identity separates files and query variations with equal names', () => {
  const original = metadata.mediaCacheFilename('https://chat.test/one/photo.jpg', 'photo.jpg');
  assert.notEqual(original, metadata.mediaCacheFilename('https://chat.test/two/photo.jpg', 'photo.jpg'));
  assert.notEqual(original, metadata.mediaCacheFilename('https://chat.test/one/photo.jpg?v=2', 'photo.jpg'));
  assert.equal(original, metadata.mediaCacheFilename('https://chat.test/one/photo.jpg', 'photo.jpg'));
  assert.ok(original.endsWith('.jpg'));
});
test('friend previews support serializer metadata without loading a media player', () => {
  assert.equal(metadata.messagePreview({ type: 'video', text: '[Contenido multimedia]' }), '[Video]');
  assert.equal(metadata.messagePreview({ image: '/media/photo.png' }), '[Imagen]');
  assert.equal(metadata.messagePreview({ type: 'text', text: 'Hola' }), 'Hola');
  assert.equal(metadata.messagePreview({ type: 'constructor' }, 'Vista previa'), 'Vista previa');
});

function downloadHarness({ status = 200, size = 42 } = {}) {
  const files = new Map();
  const calls = { downloads: 0, moves: 0, deleted: [] };
  const fileSystem = {
    cacheDirectory: 'file:///cache/',
    async getInfoAsync(uri) { return files.has(uri) ? { exists: true, size: files.get(uri) } : { exists: false }; },
    async downloadAsync(url, uri) { calls.downloads += 1; files.set(uri, size); return { status, uri }; },
    async moveAsync({ from, to }) { calls.moves += 1; files.set(to, files.get(from)); files.delete(from); },
    async deleteAsync(uri) { calls.deleted.push(uri); files.delete(uri); },
  };
  const helpers = loadModule('src/components/Message/mediaFiles.js', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system/legacy': fileSystem,
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digestStringAsync() { throw new Error('Public files do not acquire private cache identities'); } },
    'expo-media-library/legacy': {},
    '../../core/api': { resolveMediaUrl: (value) => value },
    '../../core/privateMedia': {
      captureMediaSession: () => ({ generation: 0, assertActive() {} }),
      getMediaSource: async (value) => value,
      isPrivateMediaSource: () => false,
      mediaCacheIdentity: (value) => value,
    },
    './mediaMetadata': metadata,
  });
  return { files, calls, helpers };
}
test('media cache deduplicates concurrent downloads and reuses only complete files', async () => {
  const { helpers, calls } = downloadHarness();
  const [first, second] = await Promise.all([
    helpers.cachedMediaFile('https://chat.test/video.mp4', 'video.mp4'),
    helpers.cachedMediaFile('https://chat.test/video.mp4', 'video.mp4'),
  ]);
  assert.equal(first, second);
  assert.equal(calls.downloads, 1);
  assert.equal(calls.moves, 1);
  await helpers.cachedMediaFile('https://chat.test/video.mp4', 'video.mp4');
  assert.equal(calls.downloads, 1);
  assert.equal(await helpers.cachedMediaFile('file:///recording.m4a', 'audio.m4a'), 'file:///recording.m4a');
});
test('failed or empty downloads never become cached files', async () => {
  for (const options of [{ status: 404 }, { size: 0 }]) {
    const { helpers, calls, files } = downloadHarness(options);
    await assert.rejects(helpers.cachedMediaFile('https://chat.test/video.mp4', 'video.mp4'));
    assert.equal(calls.moves, 0);
    assert.equal(files.size, 0);
    await assert.rejects(helpers.cachedMediaFile('https://chat.test/video.mp4', 'video.mp4'));
    assert.equal(calls.downloads, 2);
  }
});
test('native multipart files retain URI, filename and the actual media MIME type', async () => {
  const { helpers } = downloadHarness();
  const appended = [];
  await helpers.appendUploadFile({ append: (...args) => appended.push(args) }, { uri: 'content://video/1' }, 'video.mov', 'video/quicktime');
  assert.equal(appended[0][0], 'file');
  assert.deepEqual(JSON.parse(JSON.stringify(appended[0][1])), { uri: 'content://video/1', name: 'video.mov', type: 'video/quicktime' });
});

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}
function recordingHarness({ permission = Promise.resolve({ granted: true }), prepare = Promise.resolve() } = {}) {
  const state = [];
  const cleanups = [];
  const audioModes = [];
  const alerts = [];
  const calls = { prepared: 0, recorded: 0, stopped: 0 };
  let backgroundListener;
  let recorderStatusListener;
  const recorder = {
    uri: 'file:///audio.m4a',
    async prepareToRecordAsync() { calls.prepared += 1; await prepare; },
    record() { calls.recorded += 1; },
    async stop() { calls.stopped += 1; },
  };
  const react = {
    useState(value) { const index = state.length; state.push(value); return [value, (next) => { state[index] = next; }]; },
    useRef(value) { return { current: value }; },
    useCallback(callback) { return callback; },
    useEffect(effect) { cleanups.push(effect()); },
  };
  const useRecording = loadModule('src/core/useRecording.js', {
    react,
    'react-native': {
      Platform: { OS: 'android' }, Alert: { alert: (...args) => alerts.push(args) },
      AppState: { addEventListener(event, listener) { backgroundListener = listener; return { remove() {} }; } },
    },
    'expo-audio': {
      useAudioRecorder: (options, listener) => { recorderStatusListener = listener; return recorder; }, RecordingPresets: { HIGH_QUALITY: {} },
      AudioModule: { requestRecordingPermissionsAsync: () => permission },
      setAudioModeAsync: async (mode) => { audioModes.push(mode); },
    },
  }).default;
  return {
    hook: useRecording(), state, calls, audioModes, alerts,
    background: () => backgroundListener('background'),
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
    interrupt: () => recorderStatusListener({ isFinished: true, hasError: true }),
  };
}
test('recording serializes repeated taps, stops once, and restores playback mode', async () => {
  const { hook, calls, state, audioModes } = recordingHarness();
  const first = hook.startRecording();
  assert.equal(await hook.startRecording(), false);
  assert.equal(await first, true);
  assert.equal(state[0], true);
  const result = await hook.stopRecording();
  assert.equal(result.uri, 'file:///audio.m4a');
  assert.equal(result.mimeType, 'audio/mp4');
  assert.equal(calls.recorded, 1);
  assert.equal(calls.stopped, 1);
  assert.equal(state[0], false);
  assert.equal(audioModes.at(-1).allowsRecording, false);
});
test('cancel during microphone permission prevents enabling the microphone', async () => {
  const permission = deferred();
  const { hook, calls, audioModes } = recordingHarness({ permission: permission.promise });
  const start = hook.startRecording();
  const cancel = hook.cancelRecording();
  permission.resolve({ granted: true });
  assert.equal(await start, false);
  await cancel;
  assert.equal(calls.recorded, 0);
  assert.equal(audioModes.length, 0);
});
test('cancel or unmount during preparation releases the recorder and microphone mode', async () => {
  for (const unmount of [false, true]) {
    const prepare = deferred();
    const harness = recordingHarness({ prepare: prepare.promise });
    const start = harness.hook.startRecording();
    await new Promise((resolve) => setImmediate(resolve));
    const cancel = unmount ? harness.unmount() : harness.hook.cancelRecording();
    prepare.resolve();
    assert.equal(await start, false);
    await cancel;
    assert.equal(harness.calls.recorded, 0);
    assert.equal(harness.calls.stopped, 1);
    assert.equal(harness.audioModes.at(-1).allowsRecording, false);
  }
});
test('entering the background stops an active recording', async () => {
  const harness = recordingHarness();
  await harness.hook.startRecording();
  harness.background();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.stopped, 1);
  assert.equal(harness.state[0], false);
  assert.equal(harness.audioModes.at(-1).allowsRecording, false);
});
test('denied recording permission leaves the recorder idle', async () => {
  const harness = recordingHarness({ permission: Promise.resolve({ granted: false }) });
  assert.equal(await harness.hook.startRecording(), false);
  assert.equal(harness.calls.prepared, 0);
  assert.equal(harness.state[0], false);
  assert.equal(harness.state[1], false);
  assert.equal(harness.alerts.length, 1);
});

test('a native recording interruption updates the UI and restores playback mode', async () => {
  const harness = recordingHarness();
  await harness.hook.startRecording();
  harness.interrupt();
  assert.equal(harness.state[0], false);
  assert.equal(harness.audioModes.at(-1).allowsRecording, false);
  assert.equal(await harness.hook.stopRecording(), null);
});

function mediaSelectionHarness() {
  const selection = deferred();
  const requests = [];
  const ingested = [];
  let pickCount = 0;
  let focusCallback;
  let focusCleanup;
  const globalState = { authenticated: true, user: { username: 'me' }, ingestMessagePayload: (data) => ingested.push(data) };
  const useGlobal = (selector) => selector(globalState);
  useGlobal.getState = () => globalState;
  useGlobal.subscribe = () => () => {};
  const hook = loadModule('src/components/Message/useMessageMedia.js', {
    react: {
      useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }),
      useCallback: (callback) => callback, useEffect: (effect) => effect(),
    },
    'react-native': { Platform: { OS: 'android' }, Alert: { alert() {} } },
    '@react-navigation/native': { useFocusEffect(callback) { focusCallback = callback; focusCleanup = callback(); } },
    'expo-document-picker': {},
    'expo-image-picker': { launchImageLibraryAsync() { pickCount += 1; return selection.promise; } },
    'expo-image-manipulator': {},
    '../../core/api': { async post(url, formData) { requests.push({ url, connectionId: formData.get('connectionId') }); return { data: { message: { id: 1 } } }; } },
    '../../core/useRecording': () => ({ isRecording: false, isPreparingRecording: false, cancelRecording: async () => {} }),
    '../../core/global': useGlobal,
    '../../common/apiError': { normalizeApiError: () => 'Error' },
    './mediaFiles': { appendUploadFile: async () => {} },
    './uploadProgress': loadModule('src/components/Message/uploadProgress.js'),
    './mediaMetadata': metadata,
    './gifFiles': loadModule('src/components/Message/gifFiles.js', { './mediaMetadata': metadata }),
  }).default(42);
  return {
    hook, requests, ingested, selection, getPickCount: () => pickCount,
    blur: () => focusCleanup(), focus: () => { focusCleanup = focusCallback(); },
  };
}
test('attachment selection stays locked through preview and uploads only after explicit confirmation', async () => {
  const harness = mediaSelectionHarness();
  const first = harness.hook.onVideo();
  await harness.hook.onVideo();
  assert.equal(harness.getPickCount(), 1);
  harness.selection.resolve({ canceled: false, assets: [{ uri: 'file:///video.mov', fileName: 'video.mov' }] });
  await first;
  assert.equal(harness.requests.length, 0);
  await harness.hook.onVideo();
  assert.equal(harness.getPickCount(), 1);
  assert.equal(await harness.hook.confirmPreview(), true);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].connectionId, '42');
  assert.equal(harness.ingested.length, 1);
});
test('an attachment picked before leaving the chat cannot send after another focus', async () => {
  const harness = mediaSelectionHarness();
  const selected = harness.hook.onVideo();
  harness.blur();
  harness.focus();
  harness.selection.resolve({ canceled: false, assets: [{ uri: 'file:///video.mov', fileName: 'video.mov' }] });
  await selected;
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.ingested.length, 0);
});
