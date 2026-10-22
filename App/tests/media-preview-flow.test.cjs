const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');

function compile(relative) {
  const filename = path.join(__dirname, '..', relative);
  return { filename, code: babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
  }).code };
}
function evaluate(compiled, mocks = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compiled.code, {
    module, exports: module.exports, Promise, Blob, FormData, AbortController,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      return mocks[name];
    },
    ...globals,
  }, { filename: compiled.filename });
  return module.exports;
}
const hookSource = compile('src/components/Message/useMessageMedia.js');
const metadata = evaluate(compile('src/components/Message/mediaMetadata.js'));
const apiError = evaluate(compile('src/common/apiError.js'));
const progressHelpers = evaluate(compile('src/components/Message/uploadProgress.js'));
const gifHelpers = evaluate(compile('src/components/Message/gifFiles.js'), { './mediaMetadata': metadata }, { Uint8Array });
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the dedicated GIF picker keeps original native/web bytes and requires explicit confirmation without image manipulation', async () => {
  const bytes = Buffer.from('GIF89a-original-frame-one-and-frame-two');
  for (const platform of ['android', 'web']) {
    const file = new Blob([bytes], { type: 'image/gif' });
    const originalUri = platform === 'web' ? 'blob:animated-original' : 'file:///picker-cache/original.gif';
    const h = harness({ platform, documentAsset: { uri: originalUri, name: 'original.gif', mimeType: 'image/gif', size: bytes.length,
      ...(platform === 'web' ? { file } : {}) } });
    assert.equal(await h.action('onSelectGif'), true);
    assert.equal(h.documentCalls[0].type, 'image/gif');
    assert.equal(h.documentCalls[0].copyToCacheDirectory, true);
    assert.equal(h.documentCalls[0].multiple, false);
    assert.equal(h.documentCalls[0].base64, false);
    assert.equal(h.hook.preview.type, 'image');
    assert.equal(h.hook.preview.asset.uri, originalUri);
    assert.equal(h.requests.length, 0);
    assert.equal(h.manipulations.length, 0);
    assert.equal(await h.action('confirmPreview'), true);
    assert.equal(h.requests[0].type, 'image');
    assert.equal(h.parts[0].asset.uri, originalUri);
    assert.equal(h.parts[0].fileName, 'original.gif');
    assert.equal(h.parts[0].mimeType, 'image/gif');
    assert.equal(h.manipulations.length, 0);
    if (platform === 'web') {
      assert.equal(h.parts[0].asset.file, file);
      assert.deepEqual(Buffer.from(await h.requests[0].form.get('file').arrayBuffer()), bytes);
      assert.deepEqual(h.released, [originalUri]);
    }
    h.unmount();
  }
});

test('GIF cancellation, invalid selections and late picker/header results release URLs without uploading', async () => {
  const canceled = harness({ pickDocument: async () => ({ canceled: true, assets: null }) });
  assert.equal(await canceled.action('onSelectGif'), false);
  assert.equal(canceled.hook.preview, null);
  assert.equal(canceled.hook.previewError, null);
  for (const asset of [
    { uri: 'blob:invalid-extension', name: 'photo.jpg', mimeType: 'image/jpeg' },
    { uri: 'blob:too-large', name: 'large.gif', size: gifHelpers.GIF_MAX_BYTES + 1 },
    { uri: 'blob:invalid-header', name: 'fake.gif', file: new Blob(['bad'], { type: 'image/gif' }) },
  ]) {
    const h = harness({ platform: 'web', documentAsset: asset });
    assert.equal(await h.action('onSelectGif'), false);
    assert.equal(h.hook.preview, null);
    assert.ok(h.hook.previewError);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.released, [asset.uri]);
  }
  for (const event of ['blur', 'connection', 'logout', 'revision', 'unmount']) {
    const header = deferred();
    const h = harness({ platform: 'web', documentAsset: { uri: `blob:late-${event}`, name: 'late.gif',
      file: { type: 'image/gif', size: 10, slice: () => ({ arrayBuffer: () => header.promise }) } } });
    const preparing = h.hook.onSelectGif();
    await settle();
    if (event === 'blur') { h.blur(); h.focus(); }
    if (event === 'connection') h.setConnection(99);
    if (event === 'logout') { h.setSession({ authenticated: false }); h.setSession({ authenticated: true }); }
    if (event === 'revision') h.setRevision(42, 1);
    if (event === 'unmount') h.unmount();
    header.resolve(Uint8Array.from(Buffer.from('GIF89a')).buffer);
    assert.equal(await preparing, false);
    h.render();
    assert.equal(h.hook.preview, null);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.released, [`blob:late-${event}`]);
  }
});

test('stopping a GIF upload aborts its request, keeps the original preview and ignores stale receipt/progress without automatic retry', async () => {
  const receipt = deferred();
  const file = new Blob(['GIF89a-original'], { type: 'image/gif' });
  const h = harness({ platform: 'web', postGate: receipt.promise, ignoreAbort: true,
    documentAsset: { uri: 'blob:gif-upload', name: 'animated.gif', file, size: file.size } });
  await h.action('onSelectGif');
  const sending = h.hook.confirmPreview();
  await settle();
  const config = h.requests[0].config;
  config.onUploadProgress({ loaded: 4, total: 10 }); h.render();
  assert.equal(h.hook.uploadProgress.loaded, 4);
  assert.equal(h.hook.cancelUpload(), true); h.render();
  assert.equal(config.signal.aborted, true);
  config.onUploadProgress({ loaded: 10, total: 10 });
  receipt.resolve();
  assert.equal(await sending, false); h.render();
  assert.equal(h.hook.preview.asset.file, file);
  assert.equal(h.hook.uploadProgress.phase, 'cancelled');
  assert.equal(h.hook.uploadProgress.loaded, 4);
  assert.equal(h.ingested.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.released.length, 0);
  assert.match(h.hook.previewError, /Revisa antes de reintentar/);
  h.hook.cancelPreview(); h.render();
  assert.deepEqual(h.released, ['blob:gif-upload']);
});
const equalDeps = (first, second) => Array.isArray(first) && Array.isArray(second) &&
  first.length === second.length && first.every((value, index) => Object.is(value, second[index]));

function harness(options = {}) {
  const slots = [];
  const effects = [];
  const subscribers = new Set();
  let cursor = 0;
  const h = {
    connectionId: 42, mounted: true, focused: true, dirty: false,
    requests: [], parts: [], ingested: [], uploaded: 0, pickerCalls: [], documentCalls: [], cameraCalls: [], permissionCalls: [],
    released: [], errors: [], alerts: [], failUploads: options.failUploads || 0,
    failCompression: !!options.failCompression, manipulations: [], contextsReleased: 0, imagesReleased: 0,
    imageAsset: options.imageAsset || { uri: 'file:///original.png', fileName: 'original.png', mimeType: 'image/png', width: 2000, fileSize: 100 },
    cameraAsset: options.cameraAsset || { uri: 'file:///camera.jpg', fileName: 'camera.jpg', mimeType: 'image/jpeg', width: 2000, fileSize: 200 },
    cameraPermission: options.cameraPermission || { granted: true, canAskAgain: true },
    videoAsset: options.videoAsset || { uri: 'file:///video.mov', fileName: 'video.mov', mimeType: 'video/quicktime', fileSize: 2048, duration: 3200 },
    documentAsset: options.documentAsset || { uri: 'file:///document.pdf', name: 'document.pdf', mimeType: 'application/pdf', size: 4096 },
    audioAsset: options.audioAsset || { uri: 'blob:web-audio', name: 'audio.wav', mimeType: 'audio/wav', size: 1000 },
    recordingCalls: { starts: 0, stops: 0, cancels: 0 },
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; h.dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => {
          slots[index].cleanup?.();
          slots[index].cleanup = effect();
        });
      }
    },
  };
  h.recording = {
    isRecording: false, isPreparingRecording: false,
    async startRecording() { h.recordingCalls.starts += 1; h.recording.isRecording = true; h.dirty = true; return true; },
    async stopRecording() {
      h.recordingCalls.stops += 1;
      h.recording.isRecording = false;
      h.dirty = true;
      return options.stopRecording ? await options.stopRecording() : { uri: 'file:///recorded.m4a', fileName: 'recorded.m4a', mimeType: 'audio/mp4' };
    },
    async cancelRecording() { h.recordingCalls.cancels += 1; h.recording.isRecording = false; h.dirty = true; },
  };
  let globalState = { authenticated: true, user: { username: 'me' }, conversationHistory: options.conversationHistory || {},
    ingestMessagePayload: (data) => h.ingested.push(data) };
  const useGlobal = (selector) => selector(globalState);
  useGlobal.getState = () => globalState;
  useGlobal.subscribe = (listener) => { subscribers.add(listener); return () => subscribers.delete(listener); };
  const useMedia = evaluate(hookSource, {
    react,
    'react-native': { Platform: { OS: options.platform || 'android' }, Alert: { alert: (...args) => h.alerts.push(args) } },
    '@react-navigation/native': {
      useFocusEffect(callback) {
        react.useEffect(() => {
          h.focusCallback = callback;
          if (h.focused) h.focusCleanup = callback();
          return () => { const cleanup = h.focusCleanup; h.focusCleanup = null; cleanup?.(); };
        }, [callback]);
      },
    },
    'expo-image-picker': {
      async getCameraPermissionsAsync() {
        h.permissionCalls.push('check');
        return options.getCameraPermission ? await options.getCameraPermission() : h.cameraPermission;
      },
      async requestCameraPermissionsAsync() {
        h.permissionCalls.push('request');
        return options.requestCameraPermission ? await options.requestCameraPermission() : h.cameraPermission;
      },
      async launchCameraAsync(cameraOptions) {
        h.cameraCalls.push(cameraOptions);
        return options.takePhoto ? await options.takePhoto(cameraOptions) : { canceled: false, assets: [h.cameraAsset] };
      },
      async launchImageLibraryAsync(pickerOptions) {
        h.pickerCalls.push(pickerOptions);
        if (options.pickMedia) return await options.pickMedia(pickerOptions);
        return { canceled: false, assets: [pickerOptions.mediaTypes[0] === 'videos' ? h.videoAsset : h.imageAsset] };
      },
    },
    'expo-document-picker': {
      async getDocumentAsync(pickerOptions) {
        h.documentCalls.push(pickerOptions);
        if (options.pickDocument) return await options.pickDocument(pickerOptions);
        return { canceled: false, assets: [pickerOptions.type === 'audio/*' ? h.audioAsset : h.documentAsset] };
      },
    },
    'expo-image-manipulator': {
      SaveFormat: { PNG: 'png', JPEG: 'jpeg' },
      ImageManipulator: {
        manipulate(uri) {
          h.manipulations.push({ uri });
          return {
            resize(size) { h.manipulations.at(-1).resize = size; },
            async renderAsync() {
              if (options.prepareGate) await options.prepareGate;
              if (h.failCompression) throw new Error('No se pudo preparar la foto.');
              return {
                async saveAsync(saveOptions) { return { uri: `file:///optimized.${saveOptions.format === 'png' ? 'png' : 'jpg'}` }; },
                release() { h.imagesReleased += 1; },
              };
            },
            release() { h.contextsReleased += 1; },
          };
        },
      },
    },
    '../../core/api': {
      async post(url, form, config) {
        h.requests.push({ url, form, config, connectionId: form.get('connectionId'), historyRevision: form.get('historyRevision'), type: form.get('type') });
        if (options.postGate) await new Promise((resolve, reject) => {
          const abort = () => { const error = new Error('cancelled'); error.name = 'AbortError'; error.code = 'ERR_CANCELED'; reject(error); };
          if (!options.ignoreAbort) {
            if (config.signal.aborted) { abort(); return; }
            config.signal.addEventListener('abort', abort, { once: true });
          }
          options.postGate.then(() => { config.signal.removeEventListener('abort', abort); resolve(); });
        });
        if (h.failUploads > 0) {
          h.failUploads -= 1;
          const error = new Error('rejected');
          error.response = { data: { detail: 'No se pudo enviar este archivo.' } };
          throw error;
        }
        if (options.networkError) throw new Error('Network Error');
        return { data: options.invalidResponse ? {} : { connectionId: Number(form.get('connectionId')), message: {
          id: Object.hasOwn(options, 'receiptId') ? options.receiptId : 500, type: form.get('type'),
        } } };
      },
    },
    '../../core/useRecording': () => h.recording,
    '../../core/global': useGlobal,
    '../../common/apiError': apiError,
    './mediaFiles': {
      async appendUploadFile(form, asset, fileName, mimeType) {
        h.parts.push({ asset, fileName, mimeType });
        if (options.appendGate) await options.appendGate;
        form.append('file', asset.file || new Blob(['file'], { type: mimeType }), fileName);
      },
    },
    './mediaMetadata': metadata,
    './uploadProgress': progressHelpers,
    './gifFiles': gifHelpers,
  }, {
    console: { error: (...args) => h.errors.push(args), warn() {}, log() {} },
    URL: { revokeObjectURL: (uri) => h.released.push(uri) },
  }).default;
  h.render = () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      cursor = 0;
      h.dirty = false;
      h.hook = useMedia(h.connectionId, () => { h.uploaded += 1; });
      while (effects.length) effects.shift()();
      if (!h.dirty) return h.hook;
    }
    throw new Error('Unexpected hook render loop');
  };
  h.action = async (method, ...args) => { const result = await h.hook[method](...args); h.render(); return result; };
  h.blur = () => { h.focused = false; const cleanup = h.focusCleanup; h.focusCleanup = null; cleanup?.(); h.render(); };
  h.focus = () => { h.focused = true; h.focusCleanup = h.focusCallback(); h.render(); };
  h.setConnection = (id) => { h.connectionId = id; h.render(); };
  h.setSession = (state) => {
    const previous = globalState;
    globalState = { ...globalState, ...state };
    subscribers.forEach((listener) => listener(globalState, previous));
    h.render();
  };
  h.setRevision = (id, revision, render = true) => {
    const previous = globalState;
    globalState = { ...globalState, conversationHistory: { ...globalState.conversationHistory,
      [String(id)]: { ...globalState.conversationHistory[String(id)], revision } } };
    subscribers.forEach((listener) => listener(globalState, previous));
    if (render) h.render();
  };
  h.unmount = () => { h.mounted = false; slots.forEach((slot) => slot.cleanup?.()); };
  h.subscriberCount = () => subscribers.size;
  h.render();
  return h;
}

test('photo, video, document and web audio pickers prepare local previews without uploading or compressing', async () => {
  for (const [method, type, platform] of [['onImage', 'image', 'android'], ['onVideo', 'video', 'android'], ['onDocument', 'document', 'web'], ['onAudio', 'audio', 'web']]) {
    const h = harness({ platform });
    assert.equal(await h.action(method), true);
    assert.equal(h.hook.preview.type, type);
    assert.equal(h.requests.length, 0);
    assert.equal(h.parts.length, 0);
    assert.equal(h.manipulations.length, 0);
    assert.equal(h.hook.isBusy, false);
    assert.equal(h.hook.isUploading, false);
    assert.equal(h.hook.previewError, null);
    if (type === 'video') assert.equal(h.hook.preview.duration, 3.2);
    if (type === 'document' || type === 'audio') assert.equal(h.documentCalls[0].base64, false);
    h.unmount();
  }
});

test('native recording stops into an audio preview and waits for confirmation before sending', async () => {
  const h = harness();
  await h.action('onAudio');
  assert.equal(h.hook.isRecording, true);
  assert.equal(h.hook.preview, null);
  await h.action('onAudio');
  assert.equal(h.recordingCalls.starts, 1);
  assert.equal(h.recordingCalls.stops, 1);
  assert.equal(h.hook.isRecording, false);
  assert.equal(h.hook.preview.type, 'audio');
  assert.equal(h.hook.preview.asset.uri, 'file:///recorded.m4a');
  assert.equal(h.hook.preview.size, undefined);
  assert.equal(h.hook.preview.duration, undefined);
  assert.equal(h.requests.length, 0);
  assert.equal(await h.action('confirmPreview'), true);
  assert.equal(h.requests[0].type, 'audio');
  assert.equal(h.requests[0].connectionId, '42');
  assert.equal(h.hook.preview, null);
});

test('picker, existing preview and double confirmation share a synchronous lock and an active upload cannot discard its preview', async () => {
  const picker = deferred();
  const upload = deferred();
  const h = harness({ pickMedia: () => picker.promise, postGate: upload.promise });
  const selecting = h.hook.onVideo();
  h.render();
  assert.equal(h.hook.isBusy, true);
  assert.equal(await h.hook.onImage(), false);
  assert.equal(h.pickerCalls.length, 1);
  picker.resolve({ canceled: false, assets: [h.videoAsset] });
  await selecting;
  h.render();
  assert.equal(await h.hook.onDocument(), false);
  assert.equal(h.documentCalls.length, 0);
  const confirming = h.hook.confirmPreview();
  h.render();
  assert.equal(h.hook.isUploading, true);
  assert.equal(await h.hook.confirmPreview(), false);
  assert.equal(h.hook.cancelPreview(), false);
  await settle();
  assert.equal(h.requests.length, 1);
  upload.resolve();
  assert.equal(await confirming, true);
  h.render();
  assert.equal(h.hook.preview, null);
  assert.equal(h.hook.isUploading, false);
  assert.equal(h.ingested.length, 1);
  assert.equal(h.uploaded, 1);
});

test('upload failure preserves the selected File and exposes an inline error until a manual retry succeeds', async () => {
  const file = new Blob(['PDF'], { type: 'application/pdf' });
  const h = harness({ platform: 'web', failUploads: 1,
    documentAsset: { uri: 'blob:document', name: '../../long report.pdf', file, size: file.size } });
  await h.action('onDocument');
  assert.equal(h.hook.preview.fileName, 'long_report.pdf');
  assert.equal(h.hook.preview.mimeType, 'application/pdf');
  assert.equal(h.hook.preview.size, file.size);
  assert.equal(await h.action('confirmPreview'), false);
  assert.equal(h.hook.preview.asset.file, file);
  assert.match(h.hook.previewError, /No se pudo enviar este archivo/);
  assert.equal(h.hook.isUploading, false);
  assert.equal(h.ingested.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.released.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(await h.action('confirmPreview'), true);
  assert.equal(h.parts[0].asset.file, h.parts[1].asset.file);
  assert.equal(h.requests.length, 2);
  assert.equal(h.hook.preview, null);
  assert.equal(h.hook.previewError, null);
  assert.deepEqual(h.released, ['blob:document']);
});

test('image compression runs only on confirmation and a preparation failure keeps the original for retry', async () => {
  const h = harness({ failCompression: true,
    imageAsset: { uri: 'file:///camera.heic', fileName: 'camera.heic', mimeType: 'image/heic', width: 2000 } });
  await h.action('onImage');
  assert.equal(h.hook.preview.asset.uri, 'file:///camera.heic');
  assert.equal(h.manipulations.length, 0);
  assert.equal(await h.action('confirmPreview'), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.hook.preview.asset.uri, 'file:///camera.heic');
  assert.match(h.hook.previewError, /preparar la foto/);
  assert.equal(h.contextsReleased, 1);
  h.failCompression = false;
  assert.equal(await h.action('confirmPreview'), true);
  assert.equal(h.parts[0].asset.uri, 'file:///optimized.jpg');
  assert.equal(h.parts[0].fileName, 'camera.jpg');
  assert.equal(h.parts[0].mimeType, 'image/jpeg');
  assert.equal(h.contextsReleased, 2);
  assert.equal(h.imagesReleased, 1);
});

test('canceling a web preview releases its picker URL without sending and permits a new selection', async () => {
  const h = harness({ platform: 'web', imageAsset: { uri: 'blob:first-image', fileName: 'image.png', mimeType: 'image/png' } });
  await h.action('onImage');
  assert.equal(h.hook.cancelPreview(), true);
  h.render();
  assert.equal(h.hook.preview, null);
  assert.equal(h.hook.previewError, null);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.released, ['blob:first-image']);
  h.imageAsset = { ...h.imageAsset, uri: 'blob:next-image' };
  assert.equal(await h.action('onImage'), true);
  assert.equal(h.hook.preview.asset.uri, 'blob:next-image');
});

test('picker results arriving after blur, another conversation, logout or unmount cannot create a preview or send', async () => {
  for (const event of ['blur', 'connection', 'session', 'unmount']) {
    const picker = deferred();
    const h = harness({ platform: 'web', pickMedia: () => picker.promise });
    const selecting = h.hook.onVideo();
    if (event === 'blur') { h.blur(); h.focus(); }
    if (event === 'connection') h.setConnection(84);
    if (event === 'session') { h.setSession({ authenticated: false }); h.setSession({ authenticated: true }); }
    if (event === 'unmount') h.unmount();
    picker.resolve({ canceled: false, assets: [{ uri: `blob:stale-${event}`, fileName: 'video.mp4' }] });
    assert.equal(await selecting, false);
    if (h.mounted) h.render();
    assert.equal(h.hook.preview, null);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.released, [`blob:stale-${event}`]);
    if (event === 'unmount') assert.equal(h.subscriberCount(), 0);
  }
});

test('blur during file preparation defers URL cleanup and an old completion cannot unlock a newer upload', async () => {
  const reading = deferred();
  const uploading = deferred();
  const h = harness({ platform: 'web', appendGate: reading.promise, postGate: uploading.promise,
    videoAsset: { uri: 'blob:old-video', fileName: 'old.mp4', mimeType: 'video/mp4' },
    documentAsset: { uri: 'blob:new-document', name: 'new.pdf', mimeType: 'application/pdf' } });
  await h.action('onVideo');
  const oldConfirm = h.hook.confirmPreview();
  await settle();
  h.blur();
  assert.equal(h.hook.preview, null);
  assert.equal(h.released.length, 0);
  h.focus();
  await h.action('onDocument');
  const newConfirm = h.hook.confirmPreview();
  h.render();
  reading.resolve();
  assert.equal(await oldConfirm, false);
  await settle();
  h.render();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].type, 'document');
  assert.equal(h.hook.preview.asset.uri, 'blob:new-document');
  assert.equal(h.hook.isUploading, true);
  assert.equal(h.hook.isBusy, true);
  assert.deepEqual(h.released, ['blob:old-video']);
  uploading.resolve();
  assert.equal(await newConfirm, true);
  h.render();
  assert.equal(h.hook.preview, null);
  assert.equal(h.hook.isUploading, false);
  assert.deepEqual(h.released, ['blob:old-video', 'blob:new-document']);
});

test('a request already confirmed before leaving cannot ingest its late response into another account or conversation', async () => {
  for (const event of ['connection', 'account']) {
    const uploading = deferred();
    const h = harness({ platform: 'web', postGate: uploading.promise });
    await h.action('onAudio');
    const confirming = h.hook.confirmPreview();
    await settle();
    assert.equal(h.requests.length, 1);
    if (event === 'connection') h.setConnection(84);
    else h.setSession({ user: { username: 'other' } });
    assert.equal(h.requests[0].config.signal.aborted, true);
    uploading.resolve();
    assert.equal(await confirming, false);
    h.render();
    assert.equal(h.ingested.length, 0);
    assert.equal(h.uploaded, 0);
    assert.equal(h.hook.preview, null);
    assert.equal(h.hook.previewError, null);
    assert.deepEqual(h.released, ['blob:web-audio']);
  }
});

test('selection and recording failures expose a visible error even when there is no preview', async () => {
  const h = harness({ pickMedia: async () => { throw new Error('No se pudo abrir el selector.'); } });
  assert.equal(await h.action('onImage'), false);
  assert.equal(h.hook.preview, null);
  assert.match(h.hook.previewError, /abrir el selector/);
  assert.equal(h.hook.isBusy, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.alerts.length, 0);
  const recording = harness({ stopRecording: async () => null });
  await recording.action('onAudio');
  assert.equal(await recording.action('onAudio'), false);
  assert.equal(recording.hook.preview, null);
  assert.match(recording.hook.previewError, /audio grabado/);
  assert.equal(recording.requests.length, 0);
});

test('a malformed server confirmation cannot discard the selected file', async () => {
  const h = harness({ invalidResponse: true });
  await h.action('onVideo');
  assert.equal(await h.action('confirmPreview'), false);
  assert.equal(h.hook.preview.asset.uri, 'file:///video.mov');
  assert.match(h.hook.previewError, /No recibimos confirmación del envío/);
  assert.equal(h.ingested.length, 0);
});

test('empty or invalid receipt identifiers cannot mark a transferred file as confirmed', async () => {
  for (const receiptId of [0, -1, '', null, false, {}, NaN]) {
    const h = harness({ receiptId });
    await h.action('onVideo');
    assert.equal(await h.action('confirmPreview'), false);
    assert.ok(h.hook.preview);
    assert.equal(h.hook.uploadProgress.phase, 'failed');
    assert.equal(h.ingested.length, 0);
  }
});

test('a network failure asks to check for receipt before a manual retry and preserves the file', async () => {
  const h = harness({ networkError: true });
  await h.action('onVideo');
  assert.equal(await h.action('confirmPreview'), false);
  assert.match(h.hook.previewError, /puede haber llegado; revisa el chat/);
  assert.ok(h.hook.preview);
  assert.equal(h.requests.length, 1);
  assert.equal(h.ingested.length, 0);
});

test('real transport progress reports bytes and waits for a valid server receipt even after all bytes are uploaded', async () => {
  const response = deferred();
  const h = harness({ postGate: response.promise });
  await h.action('onVideo');
  const confirming = h.hook.confirmPreview();
  await settle();
  const config = h.requests[0].config;
  assert.equal(config.timeout, 300000);
  assert.equal(config.signal.aborted, false);
  config.onUploadProgress({ loaded: 256, total: 1024 });
  h.render();
  assert.equal(h.hook.uploadProgress.phase, 'uploading');
  assert.equal(h.hook.uploadProgress.loaded, 256);
  assert.equal(h.hook.uploadProgress.total, 1024);
  assert.equal(h.hook.uploadProgress.percent, 25);
  config.onUploadProgress({ loaded: 128, total: 1024 });
  h.render();
  assert.equal(h.hook.uploadProgress.loaded, 256);
  config.onUploadProgress({ loaded: 1024, total: 1024 });
  h.render();
  assert.equal(h.hook.uploadProgress.phase, 'processing');
  assert.equal(h.hook.uploadProgress.percent, 100);
  assert.equal(h.hook.isUploading, true);
  assert.ok(h.hook.preview);
  assert.equal(h.ingested.length, 0);
  response.resolve();
  assert.equal(await confirming, true);
  h.render();
  assert.equal(h.hook.uploadProgress.phase, 'confirmed');
  assert.equal(h.hook.preview, null);
  assert.equal(h.ingested.length, 1);
  assert.equal(h.hook.cancelUpload(), false);
});

test('unknown transfer totals stay indeterminate even when the picker knows the original file size', async () => {
  const response = deferred();
  const h = harness({ postGate: response.promise, invalidResponse: true });
  await h.action('onDocument');
  assert.equal(h.hook.preview.size, 4096);
  const confirming = h.hook.confirmPreview();
  await settle();
  h.requests[0].config.onUploadProgress({ loaded: 4096, total: undefined });
  h.render();
  assert.equal(h.hook.uploadProgress.loaded, 4096);
  assert.equal(h.hook.uploadProgress.total, null);
  assert.equal(Object.hasOwn(h.hook.uploadProgress, 'percent'), false);
  assert.equal(h.hook.uploadProgress.phase, 'uploading');
  assert.equal(h.hook.isUploading, true);
  response.resolve();
  assert.equal(await confirming, false);
  h.render();
  assert.equal(h.hook.uploadProgress.phase, 'failed');
  assert.ok(h.hook.preview);
});

test('canceling native or web transfer aborts once, retains the original and retries only after another confirmation', async () => {
  for (const platform of ['android', 'web']) {
    const response = deferred();
    const h = harness({ platform, postGate: response.promise });
    await h.action('onVideo');
    const original = h.hook.preview.asset.uri;
    const confirming = h.hook.confirmPreview();
    await settle();
    const oldConfig = h.requests[0].config;
    oldConfig.onUploadProgress({ loaded: 20, total: 100 });
    assert.equal(h.hook.cancelUpload(), true);
    assert.equal(h.hook.cancelUpload(), false);
    assert.equal(oldConfig.signal.aborted, true);
    assert.equal(await confirming, false);
    h.render();
    assert.equal(h.hook.preview.asset.uri, original);
    assert.equal(h.hook.uploadProgress.phase, 'cancelled');
    assert.equal(h.hook.uploadProgress.loaded, 20);
    assert.match(h.hook.previewError, /puede aparecer en el chat/);
    assert.equal(h.hook.isUploading, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.ingested.length, 0);
    assert.equal(h.released.length, 0);
    oldConfig.onUploadProgress({ loaded: 100, total: 100 });
    h.render();
    assert.equal(h.hook.uploadProgress.loaded, 20);
    const retry = h.hook.confirmPreview();
    await settle();
    assert.equal(h.requests.length, 2);
    assert.notEqual(h.requests[1].config.signal, oldConfig.signal);
    assert.equal(h.requests[1].config.signal.aborted, false);
    response.resolve();
    assert.equal(await retry, true);
    h.render();
    assert.equal(h.hook.preview, null);
  }
});

test('canceling during asynchronous compression or file preparation cannot start a network request afterwards', async () => {
  for (const kind of ['compression', 'file']) {
    const preparing = deferred();
    const h = harness(kind === 'compression' ? { prepareGate: preparing.promise } : { appendGate: preparing.promise });
    await h.action(kind === 'compression' ? 'onImage' : 'onVideo');
    const original = h.hook.preview.asset.uri;
    const confirming = h.hook.confirmPreview();
    await settle();
    h.render();
    assert.equal(h.hook.uploadProgress.phase, 'preparing');
    assert.equal(h.hook.cancelUpload(), true);
    assert.equal(h.hook.cancelUpload(), false);
    preparing.resolve();
    assert.equal(await confirming, false);
    h.render();
    assert.equal(h.requests.length, 0);
    assert.equal(h.hook.preview.asset.uri, original);
    assert.equal(h.hook.isBusy, false);
    assert.equal(h.hook.isUploading, false);
    assert.match(h.hook.previewError, /El archivo no se envió/);
  }
});

test('aborted progress and receipt callbacks cannot overwrite a newer conversation upload', async () => {
  const response = deferred();
  const h = harness({ postGate: response.promise, ignoreAbort: true });
  await h.action('onVideo');
  const previous = h.hook.confirmPreview();
  await settle();
  const oldConfig = h.requests[0].config;
  h.setConnection(84);
  await h.action('onDocument');
  const current = h.hook.confirmPreview();
  await settle();
  const currentConfig = h.requests[1].config;
  currentConfig.onUploadProgress({ loaded: 256, total: 1024 });
  oldConfig.onUploadProgress({ loaded: 4096, total: 4096 });
  h.render();
  assert.equal(h.hook.preview.type, 'document');
  assert.equal(h.hook.uploadProgress.percent, 25);
  assert.equal(h.hook.uploadProgress.phase, 'uploading');
  assert.equal(h.hook.isUploading, true);
  response.resolve();
  assert.equal(await previous, false);
  assert.equal(await current, true);
  h.render();
  assert.equal(h.ingested.length, 1);
  assert.equal(h.ingested[0].connectionId, 84);
  assert.equal(h.hook.uploadProgress.phase, 'confirmed');
});

test('media confirmation sends the conversation revision captured before selection', async () => {
  for (const [method, type] of [['onImage', 'image'], ['onVideo', 'video'], ['onDocument', 'document'], ['onAudio', 'audio']]) {
    const h = harness({ platform: 'web', conversationHistory: { 42: { revision: 7 } } });
    await h.action(method);
    assert.equal(await h.action('confirmPreview'), true);
    assert.equal(h.requests[0].type, type);
    assert.equal(h.requests[0].historyRevision, '7');
    h.unmount();
  }
  const initial = harness();
  await initial.action('onVideo'); await initial.action('confirmPreview');
  assert.equal(initial.requests[0].historyRevision, '0');
});

test('conversation deletion invalidates picker results and existing previews synchronously without a render', async () => {
  const picker = deferred();
  const h = harness({ platform: 'web', conversationHistory: { 42: { revision: 2 } }, pickMedia: () => picker.promise });
  const picking = h.hook.onVideo();
  h.setRevision(42, 3, false);
  picker.resolve({ canceled: false, assets: [{ uri: 'blob:before-delete', fileName: 'video.mp4' }] });
  assert.equal(await picking, false);
  h.render();
  assert.equal(h.hook.preview, null); assert.deepEqual(h.released, ['blob:before-delete']);
  const preview = harness({ platform: 'web', conversationHistory: { 42: { revision: 4 } } });
  await preview.action('onAudio');
  preview.setRevision(84, 1, false);
  assert.ok(preview.hook.preview);
  preview.setRevision(42, 4, false);
  assert.equal(preview.released.length, 0);
  preview.setRevision(42, 5, false);
  assert.equal(await preview.hook.confirmPreview(), false);
  assert.equal(preview.requests.length, 0);
  assert.deepEqual(preview.released, ['blob:web-audio']);
  preview.render(); assert.equal(preview.hook.preview, null);
});

test('a deleted conversation aborts file preparation and releases its URL after the reader finishes', async () => {
  const reader = deferred();
  const h = harness({ platform: 'web', appendGate: reader.promise,
    conversationHistory: { 42: { revision: 1 } }, videoAsset: { uri: 'blob:reading-video', fileName: 'video.mp4' } });
  await h.action('onVideo');
  const confirming = h.hook.confirmPreview(); await settle();
  h.setRevision(42, 2, false);
  assert.equal(h.released.length, 0);
  reader.resolve();
  assert.equal(await confirming, false);
  h.render();
  assert.equal(h.requests.length, 0); assert.equal(h.hook.preview, null);
  assert.equal(h.hook.isUploading, false); assert.deepEqual(h.released, ['blob:reading-video']);
});

test('deletion aborts active transport and late callbacks cannot restore an attachment or unlock the new revision', async () => {
  const response = deferred();
  const h = harness({ platform: 'web', conversationHistory: { 42: { revision: 8 } },
    postGate: response.promise, ignoreAbort: true,
    videoAsset: { uri: 'blob:old-history-video', fileName: 'old.mp4' },
    documentAsset: { uri: 'blob:new-history-document', name: 'new.pdf', mimeType: 'application/pdf' } });
  await h.action('onVideo');
  const previous = h.hook.confirmPreview(); await settle();
  const previousConfig = h.requests[0].config;
  h.setRevision(42, 9, false);
  assert.equal(previousConfig.signal.aborted, true);
  previousConfig.onUploadProgress({ loaded: 100, total: 100 });
  h.render();
  assert.equal(h.hook.preview, null); assert.equal(h.hook.uploadProgress, null);
  await h.action('onDocument');
  const current = h.hook.confirmPreview(); await settle();
  assert.equal(h.requests[0].historyRevision, '8'); assert.equal(h.requests[1].historyRevision, '9');
  h.requests[1].config.onUploadProgress({ loaded: 20, total: 100 });
  previousConfig.onUploadProgress({ loaded: 100, total: 100 });
  h.render(); assert.equal(h.hook.uploadProgress.percent, 20); assert.equal(h.hook.isUploading, true);
  response.resolve();
  assert.equal(await previous, false); assert.equal(await current, true);
  h.render(); assert.equal(h.ingested.length, 1); assert.equal(h.uploaded, 1);
  assert.deepEqual(h.released, ['blob:old-history-video', 'blob:new-history-document']);
});

test('history revision changes cancel native microphone capture and reject late recording results', async () => {
  const h = harness({ conversationHistory: { 42: { revision: 2 } } });
  await h.action('onAudio'); assert.equal(h.hook.isRecording, true);
  h.setRevision(42, 3, false);
  assert.equal(h.recordingCalls.cancels, 1);
  h.render(); assert.equal(h.hook.isRecording, false);
  const recorded = deferred();
  const late = harness({ conversationHistory: { 42: { revision: 5 } }, stopRecording: () => recorded.promise });
  await late.action('onAudio');
  const finishing = late.hook.onAudio();
  late.setRevision(42, 6, false);
  recorded.resolve({ uri: 'file:///stale-recording.m4a', fileName: 'recording.m4a', mimeType: 'audio/mp4' });
  assert.equal(await finishing, false);
  late.render(); assert.equal(late.hook.preview, null); assert.equal(late.requests.length, 0);
});

test('camera permissions are checked only after choosing camera and a photo is reviewed before explicit multipart upload', async () => {
  const h = harness({ conversationHistory: { 42: { revision: 8 } } });
  assert.deepEqual(h.permissionCalls, []);
  assert.deepEqual(h.cameraCalls, []);
  await h.action('onImage');
  assert.deepEqual(h.permissionCalls, []);
  h.hook.cancelPreview(); h.render();
  assert.equal(await h.action('onCamera'), true);
  assert.deepEqual(h.permissionCalls, ['check']);
  assert.equal(h.cameraCalls.length, 1);
  assert.equal(h.cameraCalls[0].mediaTypes[0], 'images');
  assert.equal(h.cameraCalls[0].allowsEditing, false);
  assert.equal(h.cameraCalls[0].cameraType, 'back');
  assert.equal(h.hook.preview.type, 'image');
  assert.equal(h.hook.preview.asset.uri, 'file:///camera.jpg');
  assert.equal(h.requests.length, 0);
  assert.equal(h.parts.length, 0);
  assert.equal(h.manipulations.length, 0);
  assert.equal(await h.action('confirmPreview'), true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].historyRevision, '8');
  assert.equal(h.requests[0].type, 'image');
  assert.equal(h.parts[0].fileName, 'camera.jpg');
  assert.equal(h.parts[0].mimeType, 'image/jpeg');
  assert.equal(h.parts[0].asset.uri, 'file:///optimized.jpg');
});

test('denied camera access explains how to continue, permits manual retry and does not repeatedly request blocked permission', async () => {
  for (const canAskAgain of [true, false]) {
    const h = harness({ cameraPermission: { granted: false, canAskAgain } });
    assert.equal(await h.action('onCamera'), false);
    assert.deepEqual(h.permissionCalls, canAskAgain ? ['check', 'request'] : ['check']);
    assert.equal(h.cameraCalls.length, 0);
    assert.equal(h.hook.preview, null);
    assert.match(h.hook.previewError, canAskAgain ? /permite el acceso/ : /ajustes de la app/);
    assert.equal(h.hook.isBusy, false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.alerts.length, 0);
    h.cameraPermission = { granted: true, canAskAgain: true };
    assert.equal(await h.action('onCamera'), true);
    assert.equal(h.cameraCalls.length, 1);
    assert.equal(h.hook.previewError, null);
  }
});

test('granting the requested camera permission opens one camera and canceling it never creates a preview or uploads', async () => {
  const h = harness({ cameraPermission: { granted: false, canAskAgain: true },
    requestCameraPermission: async () => ({ granted: true, canAskAgain: true }),
    takePhoto: async () => ({ canceled: true, assets: null }) });
  assert.equal(await h.action('onCamera'), false);
  assert.deepEqual(h.permissionCalls, ['check', 'request']);
  assert.equal(h.cameraCalls.length, 1);
  assert.equal(h.hook.preview, null);
  assert.equal(h.hook.previewError, null);
  assert.equal(h.hook.isBusy, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.manipulations.length, 0);
});

test('pending camera permissions cannot open the camera after blur, account change, conversation deletion or unmount', async () => {
  for (const phase of ['check', 'request']) {
    for (const event of ['blur', 'connection', 'account', 'logout', 'revision', 'unmount']) {
      const permission = deferred();
      const h = harness({ cameraPermission: { granted: false, canAskAgain: true },
        ...(phase === 'check' ? { getCameraPermission: () => permission.promise }
          : { requestCameraPermission: () => permission.promise }) });
      const opening = h.hook.onCamera(); await settle();
      if (event === 'blur') { h.blur(); h.focus(); }
      if (event === 'connection') h.setConnection(84);
      if (event === 'account') h.setSession({ user: { username: 'other' } });
      if (event === 'logout') { h.setSession({ authenticated: false }); h.setSession({ authenticated: true }); }
      if (event === 'revision') h.setRevision(42, 1, false);
      if (event === 'unmount') h.unmount();
      permission.resolve({ granted: true, canAskAgain: true });
      assert.equal(await opening, false, `${phase}/${event}`);
      if (h.mounted) h.render();
      assert.equal(h.cameraCalls.length, 0, `${phase}/${event}`);
      assert.equal(h.hook.preview, null);
      assert.equal(h.requests.length, 0);
    }
  }
});

test('a camera result arriving after blur, connection, account, revision or unmount is discarded and cannot send', async () => {
  for (const platform of ['android', 'web']) {
    for (const event of ['blur', 'connection', 'account', 'logout', 'revision', 'unmount']) {
      const camera = deferred();
      const h = harness({ platform, takePhoto: () => camera.promise });
      const opening = h.hook.onCamera(); await settle();
      assert.equal(h.cameraCalls.length, 1);
      if (event === 'blur') { h.blur(); h.focus(); }
      if (event === 'connection') h.setConnection(84);
      if (event === 'account') h.setSession({ user: { username: 'other' } });
      if (event === 'logout') { h.setSession({ authenticated: false }); h.setSession({ authenticated: true }); }
      if (event === 'revision') h.setRevision(42, 1, false);
      if (event === 'unmount') h.unmount();
      const uri = platform === 'web' ? `blob:camera-${event}` : `file:///camera-${event}.jpg`;
      camera.resolve({ canceled: false, assets: [{ uri, fileName: 'camera.jpg', mimeType: 'image/jpeg' }] });
      assert.equal(await opening, false, `${platform}/${event}`);
      if (h.mounted) h.render();
      assert.equal(h.hook.preview, null);
      assert.equal(h.requests.length, 0);
      assert.deepEqual(h.released, platform === 'web' ? [uri] : []);
    }
  }
});

test('camera capture shares picker locks, respects recording and cannot replace an existing preview', async () => {
  const camera = deferred();
  const h = harness({ takePhoto: () => camera.promise });
  const opening = h.hook.onCamera(); await settle();
  assert.equal(await h.hook.onCamera(), false);
  assert.equal(await h.hook.onImage(), false);
  assert.equal(await h.hook.onVideo(), false);
  assert.equal(h.cameraCalls.length, 1);
  assert.equal(h.pickerCalls.length, 0);
  camera.resolve({ canceled: false, assets: [h.cameraAsset] });
  assert.equal(await opening, true); h.render();
  assert.equal(await h.action('onCamera'), false);
  assert.equal(h.cameraCalls.length, 1);
  h.hook.cancelPreview(); h.render();
  await h.action('onAudio');
  assert.equal(await h.action('onCamera'), false);
  assert.equal(h.cameraCalls.length, 1);
  h.recording.isRecording = false; h.recording.isPreparingRecording = true; h.render();
  assert.equal(await h.action('onCamera'), false);
  assert.equal(h.cameraCalls.length, 1);
});

test('web camera/file capture launches synchronously within the gesture without requesting native permissions', async () => {
  const camera = deferred();
  const file = new Blob(['camera-image'], { type: 'image/png' });
  const h = harness({ platform: 'web', takePhoto: () => camera.promise });
  const opening = h.hook.onCamera();
  assert.equal(h.cameraCalls.length, 1);
  assert.deepEqual(h.permissionCalls, []);
  camera.resolve({ canceled: false, assets: [{ uri: 'blob:web-camera', fileName: 'camera.png', mimeType: 'image/png', file }] });
  assert.equal(await opening, true); h.render();
  assert.equal(h.hook.preview.asset.file, file);
  assert.equal(h.requests.length, 0);
  assert.equal(await h.action('confirmPreview'), true);
  assert.equal(h.parts[0].asset.file, file);
  assert.equal(h.manipulations.length, 0);
  assert.deepEqual(h.released, ['blob:web-camera']);
});

test('camera launch failures remain visible and a later manual retry can prepare a photo', async () => {
  let fail = true;
  const h = harness({ takePhoto: async () => {
    if (fail) throw new Error('Native or browser camera unavailable');
    return { canceled: false, assets: [h.cameraAsset] };
  } });
  assert.equal(await h.action('onCamera'), false);
  assert.match(h.hook.previewError, /No se pudo abrir la cámara.*galería/);
  assert.equal(h.hook.isBusy, false);
  assert.equal(h.hook.preview, null);
  assert.equal(h.requests.length, 0);
  fail = false;
  assert.equal(await h.action('onCamera'), true);
  assert.equal(h.hook.previewError, null);
  assert.equal(h.hook.preview.asset.uri, h.cameraAsset.uri);
});

test('deferred system picker choices retain their original focus, account and conversation revision before any permission or capture', async () => {
  for (const method of ['onImage', 'onCamera']) {
    for (const event of ['blur', 'connection', 'account', 'logout', 'revision', 'unmount']) {
      const h = harness();
      const launch = h.hook.guardSelection(h.hook[method]);
      assert.equal(h.pickerCalls.length, 0); assert.equal(h.permissionCalls.length, 0); assert.equal(h.cameraCalls.length, 0);
      if (event === 'blur') { h.blur(); h.focus(); }
      if (event === 'connection') h.setConnection(84);
      if (event === 'account') h.setSession({ user: { username: 'other' } });
      if (event === 'logout') { h.setSession({ authenticated: false }); h.setSession({ authenticated: true }); }
      if (event === 'revision') h.setRevision(42, 1, false);
      if (event === 'unmount') h.unmount();
      assert.equal(await launch(), false, `${method}/${event}`);
      assert.equal(h.pickerCalls.length, 0); assert.equal(h.permissionCalls.length, 0); assert.equal(h.cameraCalls.length, 0);
      assert.equal(h.requests.length, 0);
    }
  }
  const h = harness();
  const launch = h.hook.guardSelection(h.hook.onCamera);
  assert.equal(await launch(), true); h.render();
  h.hook.cancelPreview(); h.render();
  assert.equal(await launch(), false, 'A deferred choice can only execute once');
  assert.equal(h.cameraCalls.length, 1);
});
