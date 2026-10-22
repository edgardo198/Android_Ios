const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function localStream({ video = false, audio = true, applyConstraints } = {}) {
  const tracks = [];
  const events = [];
  function add(kind) {
    const track = {
      kind, enabled: true, readyState: 'live', stops: 0, releases: 0,
      stop() { this.stops += 1; this.readyState = 'ended'; events.push(`${kind}:stop`); },
      release() { this.releases += 1; events.push(`${kind}:release`); },
    };
    if (kind === 'video') track.applyConstraints = applyConstraints || (async () => {});
    tracks.push(track);
  }
  if (audio) add('audio');
  if (video) add('video');
  const stream = {
    releases: 0, tracks, events,
    getTracks: () => tracks.slice(),
    toURL: () => 'native-local-stream',
    release() { this.releases += 1; tracks.forEach((track) => track.release()); events.push('stream:release'); },
  };
  return stream;
}

function harness(options = {}) {
  const calls = { imports: 0, captures: [], permissions: [], permissionBatches: [], checks: [] };
  const cameraView = function CameraView() {};
  const permission = { RECORD_AUDIO: 'microphone', CAMERA: 'camera' };
  const nativeModules = options.nativeModule === false ? {} : { WebRTCModule: {} };
  const mocks = {
    'react-native': {
      Platform: { OS: options.os || 'android' }, NativeModules: nativeModules,
      PermissionsAndroid: {
        PERMISSIONS: permission, RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
        async check(kind) {
          calls.checks.push(kind);
          return options.check ? options.check(kind) : true;
        },
        async requestMultiple(kinds) {
          calls.permissionBatches.push(Array.from(kinds));
          calls.permissions.push(...kinds);
          if (options.requestMultiple) return options.requestMultiple(kinds);
          const results = {};
          for (const kind of kinds) results[kind] = options.request ? await options.request(kind) : 'granted';
          return results;
        },
      },
    },
    expo: { isRunningInExpoGo: () => Boolean(options.expoGo) },
    'expo-constants': { executionEnvironment: options.environment || 'bare' },
    'react-native-webrtc': {
      RTCView: cameraView,
      mediaDevices: {
        async getUserMedia(constraints) {
          calls.captures.push(constraints);
          return options.capture ? options.capture(constraints) : localStream({ video: Boolean(constraints.video) });
        },
      },
      RTCPeerConnection() { throw new Error('A local test must never open a peer connection'); },
    },
  };
  const filename = path.join(__dirname, '..', 'src/calls/nativeRtc.js');
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Promise,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      if (name === 'react-native-webrtc') {
        calls.imports += 1;
        if (options.importError) throw new Error('Native WebRTC module unavailable');
      }
      return mocks[name];
    },
  }, { filename });
  return { api: module.exports, calls, cameraView };
}

test('web, Expo Go and missing native binaries remain safe without importing RTC or requesting permissions', async () => {
  for (const options of [
    { os: 'web' }, { os: 'windows' },
    { expoGo: true, environment: 'storeClient' },
    { expoGo: true, environment: 'bare' },
    { nativeModule: false, environment: 'storeClient' },
    { nativeModule: false },
  ]) {
    const h = harness(options);
    assert.equal(h.api.getNativeRtcAvailability().available, false);
    assert.match(h.api.getNativeRtcAvailability().reason, /app instalada|Expo Go|versión/);
    assert.equal(h.api.getNativeRtcView(), null);
    await assert.rejects(h.api.startLocalCapture(), { code: 'CAPTURE_UNAVAILABLE' });
    h.api.cancelLocalCapture();
    h.api.cancelLocalCapture();
    assert.equal(h.calls.imports, 0);
    assert.equal(h.calls.captures.length, 0);
    assert.equal(h.calls.checks.length, 0);
  }
});

test('availability is lazy, permits a native development client and never starts capture', () => {
  const h = harness({ environment: 'storeClient' });
  assert.equal(h.calls.imports, 0);
  assert.equal(h.api.getNativeRtcAvailability().available, true);
  assert.equal(h.api.getNativeRtcView(), h.cameraView);
  assert.equal(h.calls.imports, 1);
  assert.equal(h.calls.captures.length, 0);
  assert.equal(h.calls.checks.length, 0);
});

test('a broken native module reports a readable unavailable reason instead of crashing on import', async () => {
  const h = harness({ importError: true });
  assert.equal(h.api.getNativeRtcAvailability().available, false);
  assert.match(h.api.getNativeRtcAvailability().reason, /versión actualizada/);
  await assert.rejects(h.api.startLocalCapture(), { code: 'CAPTURE_UNAVAILABLE' });
  assert.equal(h.calls.captures.length, 0);
});

test('denied microphone and camera permissions prevent capture and identify the needed permission', async () => {
  for (const [deniedKind, code] of [['microphone', 'MICROPHONE_PERMISSION_DENIED'], ['camera', 'CAMERA_PERMISSION_DENIED']]) {
    const h = harness({ check: () => false, request: (kind) => kind === deniedKind ? 'never_ask_again' : 'granted' });
    await assert.rejects(h.api.startLocalCapture({ video: true }), (error) => error.code === code && /ajustes/.test(error.message));
    assert.equal(h.calls.captures.length, 0);
    assert.deepEqual(h.calls.permissionBatches, [['microphone', 'camera']]);
  }
});

test('Android asks once for only missing permissions, and a microphone test never requests camera access', async () => {
  for (const [video, alreadyGranted, expected] of [
    [false, [], ['microphone']], [true, ['microphone'], ['camera']],
    [true, ['camera'], ['microphone']], [true, ['microphone', 'camera'], []],
  ]) {
    const h = harness({ check: (kind) => alreadyGranted.includes(kind) });
    const lease = await h.api.startLocalCapture({ video });
    assert.deepEqual(h.calls.permissions, expected);
    assert.deepEqual(h.calls.permissionBatches, expected.length ? [expected] : []);
    if (!video) assert.deepEqual(h.calls.checks, ['microphone']);
    lease.stop();
  }
});

test('cancellation during a permission request never captures after its late answer', async () => {
  const permission = deferred();
  const h = harness({ check: () => false, requestMultiple: () => permission.promise });
  const controller = new AbortController();
  const capture = h.api.startLocalCapture({ video: true, signal: controller.signal });
  const rejection = assert.rejects(capture, { code: 'CAPTURE_CANCELLED', stage: 'permissions' });
  await flush();
  assert.deepEqual(h.calls.permissionBatches, [['microphone', 'camera']]);
  controller.abort();
  h.api.cancelLocalCapture();
  permission.resolve({ microphone: 'granted', camera: 'granted' });
  await rejection;
  assert.deepEqual(h.calls.permissionBatches, [['microphone', 'camera']]);
  assert.equal(h.calls.captures.length, 0);
});

test('cancellation while checking permissions prevents any later system dialog', async () => {
  const permission = deferred();
  const h = harness({ check: () => permission.promise });
  const controller = new AbortController();
  const capture = h.api.startLocalCapture({ video: true, signal: controller.signal });
  const rejection = assert.rejects(capture, { code: 'CAPTURE_CANCELLED', stage: 'permissions' });
  controller.abort();
  permission.resolve(false);
  await rejection;
  assert.deepEqual(h.calls.checks, ['microphone']);
  assert.equal(h.calls.permissionBatches.length, 0);
  assert.equal(h.calls.captures.length, 0);
});

test('a signal aborted before start neither imports the engine nor prompts for permissions', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.api.startLocalCapture({ signal: controller.signal }), { code: 'CAPTURE_CANCELLED' });
  assert.equal(h.calls.imports, 0);
  assert.equal(h.calls.checks.length, 0);
});

test('single flight blocks a changed mode and releases a late stream exactly once after double cancellation', async () => {
  const nativeCapture = deferred();
  const late = localStream({ video: true });
  let attempts = 0;
  const h = harness({ capture: () => ++attempts === 1 ? nativeCapture.promise : localStream({ video: true }) });
  const controller = new AbortController();
  const first = h.api.startLocalCapture({ video: true, signal: controller.signal });
  assert.equal(h.api.startLocalCapture({ video: true }), first);
  await assert.rejects(h.api.startLocalCapture({ video: false }), { code: 'CAPTURE_BUSY' });
  const rejection = assert.rejects(first, { code: 'CAPTURE_CANCELLED', stage: 'capture' });
  await flush();
  assert.equal(h.calls.captures.length, 1);
  controller.abort();
  h.api.cancelLocalCapture();
  h.api.cancelLocalCapture();
  await assert.rejects(h.api.startLocalCapture({ video: true }), { code: 'CAPTURE_BUSY' });
  nativeCapture.resolve(late);
  await rejection;
  assert.equal(late.releases, 1);
  late.tracks.forEach((track) => { assert.equal(track.stops, 1); assert.equal(track.releases, 1); });
  const retry = await h.api.startLocalCapture({ video: true });
  assert.equal(h.calls.captures.length, 2);
  retry.stop();
});

test('an active lease mutes tracks, shares capture and stops/releases idempotently', async () => {
  const stream = localStream({ video: true });
  const h = harness({ capture: () => stream });
  const lease = await h.api.startLocalCapture({ video: true });
  assert.equal(await h.api.startLocalCapture({ video: true }), lease);
  assert.equal(lease.stream.toURL(), 'native-local-stream');
  assert.equal(lease.setMicrophoneEnabled(false), true);
  assert.equal(stream.tracks[0].enabled, false);
  assert.equal(lease.setMicrophoneEnabled(true), true);
  assert.equal(stream.tracks[0].enabled, true);
  await assert.rejects(h.api.startLocalCapture(), { code: 'CAPTURE_BUSY' });
  lease.stop();
  lease.stop();
  h.api.cancelLocalCapture();
  assert.equal(stream.releases, 1);
  stream.tracks.forEach((track) => { assert.equal(track.stops, 1); assert.equal(track.releases, 1); });
  assert.deepEqual(stream.events.slice(0, 2), ['audio:stop', 'video:stop']);
  assert.equal(lease.setMicrophoneEnabled(true), false);
  assert.equal(await lease.switchCamera(), false);
  assert.equal(h.calls.captures.length, 1);
  assert.equal(h.calls.captures[0].audio, true);
  assert.equal(h.calls.captures[0].video.facingMode, 'user');
});

test('an abort signal also closes an already active lease without acquiring another stream', async () => {
  const stream = localStream();
  const h = harness({ capture: () => stream });
  const controller = new AbortController();
  const lease = await h.api.startLocalCapture({ signal: controller.signal });
  controller.abort();
  lease.stop();
  assert.equal(stream.releases, 1);
  assert.equal(stream.tracks[0].stops, 1);
  assert.equal(h.calls.captures[0].video, false);
  assert.deepEqual(h.calls.checks, ['microphone']);
});

test('native partial permission results are rejected and release every obtained track', async () => {
  for (const options of [{ video: true, audio: false }, { video: false, audio: true }]) {
    const stream = localStream(options);
    const h = harness({ os: 'ios', capture: () => stream });
    await assert.rejects(h.api.startLocalCapture({ video: true }), {
      code: options.audio ? 'CAMERA_PERMISSION_DENIED' : 'MICROPHONE_PERMISSION_DENIED',
    });
    assert.equal(stream.releases, 1);
    stream.tracks.forEach((track) => { assert.equal(track.stops, 1); assert.equal(track.releases, 1); });
    assert.equal(h.calls.permissions.length, 0);
  }
});

test('native capture errors are translated and a failed attempt unlocks a new capture', async () => {
  let attempts = 0;
  const h = harness({ os: 'ios', capture: () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('Permission denied.'), { name: 'SecurityError', code: 'NATIVE_ERROR' });
    return localStream();
  } });
  await assert.rejects(h.api.startLocalCapture(), (error) => error.code === 'CAPTURE_PERMISSION_DENIED' && /micrófono/.test(error.message));
  const lease = await h.api.startLocalCapture();
  lease.stop();
  assert.equal(attempts, 2);
});

test('camera changes use awaited constraints, coalesce taps and ignore a result after stop', async () => {
  const change = deferred();
  const constraints = [];
  const stream = localStream({ video: true, applyConstraints: (next) => { constraints.push(next); return change.promise; } });
  const h = harness({ capture: () => stream });
  const lease = await h.api.startLocalCapture({ video: true });
  const first = lease.switchCamera();
  assert.equal(lease.switchCamera(), first);
  await flush();
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].facingMode, 'environment');
  lease.stop();
  change.resolve();
  assert.equal(await first, false);
  assert.equal(stream.releases, 1);
});

test('a synchronous camera failure reports a Spanish error and allows retrying the switch', async () => {
  let attempts = 0;
  const modes = [];
  const stream = localStream({ video: true, applyConstraints: (next) => {
    modes.push(next.facingMode);
    attempts += 1;
    if (attempts === 1) throw new Error('Camera failure');
    return Promise.resolve();
  } });
  const h = harness({ capture: () => stream });
  const lease = await h.api.startLocalCapture({ video: true });
  await assert.rejects(lease.switchCamera(), (error) => error.code === 'CAMERA_SWITCH_FAILED' && /cámara/.test(error.message));
  assert.equal(await lease.switchCamera(), true);
  assert.equal(await lease.switchCamera(), true);
  assert.deepEqual(modes, ['environment', 'environment', 'user']);
  lease.stop();
});

test('stopping before a queued camera switch begins never calls a released native track', async () => {
  let changes = 0;
  const stream = localStream({ video: true, applyConstraints: async () => { changes += 1; } });
  const h = harness({ capture: () => stream });
  const lease = await h.api.startLocalCapture({ video: true });
  const change = lease.switchCamera();
  lease.stop();
  assert.equal(await change, false);
  assert.equal(changes, 0);
  assert.equal(stream.releases, 1);
});

test('cleanup continues to release other tracks if stopping one native track throws', async () => {
  const stream = localStream({ video: true });
  stream.tracks[0].stop = () => { throw new Error('Already stopped'); };
  const h = harness({ capture: () => stream });
  const lease = await h.api.startLocalCapture({ video: true });
  assert.doesNotThrow(() => lease.stop());
  assert.equal(stream.tracks[1].stops, 1);
  stream.tracks.forEach((track) => assert.equal(track.releases, 1));
  assert.equal(stream.releases, 1);
});

test('exclusive calls cannot borrow or abort an existing diagnostic capture while pending or active', async () => {
  const pending = deferred();
  const stream = localStream();
  const h = harness({ capture: () => pending.promise });
  const diagnostic = h.api.startLocalCapture();
  await flush();
  const rejectedOwner = new AbortController();
  await assert.rejects(h.api.startLocalCapture({ exclusive: true, signal: rejectedOwner.signal }), { code: 'CAPTURE_BUSY' });
  rejectedOwner.abort();
  pending.resolve(stream);
  const lease = await diagnostic;
  assert.equal(stream.releases, 0);
  await assert.rejects(h.api.startLocalCapture({ exclusive: true }), { code: 'CAPTURE_BUSY' });
  assert.equal(h.calls.captures.length, 1);
  lease.stop();
  assert.equal(stream.releases, 1);
});

test('an exclusive real-call capture cannot be shared with diagnostics or another real call', async () => {
  const pending = deferred();
  let captures = 0;
  const h = harness({ capture: () => ++captures === 1 ? pending.promise : localStream() });
  const call = h.api.startLocalCapture({ exclusive: true });
  await flush();
  await assert.rejects(h.api.startLocalCapture(), { code: 'CAPTURE_BUSY' });
  await assert.rejects(h.api.startLocalCapture({ exclusive: true }), { code: 'CAPTURE_BUSY' });
  pending.resolve(localStream());
  const lease = await call;
  await assert.rejects(h.api.startLocalCapture(), { code: 'CAPTURE_BUSY' });
  lease.stop();
  const next = await h.api.startLocalCapture();
  next.stop();
  assert.equal(h.calls.captures.length, 2);
});
