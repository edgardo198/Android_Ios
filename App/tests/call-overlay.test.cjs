const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

const filename = path.join(__dirname, '../src/calls/CallOverlay.jsx');
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  filename, configFile: false, babelrc: false,
  plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
    require('@babel/plugin-transform-modules-commonjs')],
});
const presentationFilename = path.join(__dirname, '../src/calls/callPresentation.js');
const presentationCode = babel.transformSync(fs.readFileSync(presentationFilename, 'utf8'), {
  filename: presentationFilename, configFile: false, babelrc: false,
  plugins: [require('@babel/plugin-transform-modules-commonjs')],
}).code;
const presentationModule = { exports: {} };
vm.runInNewContext(presentationCode, { module: presentationModule, exports: presentationModule.exports });

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (tree && typeof tree === 'object') return textContent(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let props = options.props || {};
  const calls = { accept: 0, reject: 0, end: 0, mute: 0, switch: 0, video: 0, routes: [], dismiss: 0, views: 0, plays: 0, pauses: 0 };
  const timers = new Set();
  let provider = {
    call: options.call || null, error: options.error || null,
    availability: { available: true }, connected: true,
    async acceptCall() { calls.accept += 1; if (options.acceptGate) await options.acceptGate; },
    async rejectCall() { calls.reject += 1; },
    async endCall() { calls.end += 1; },
    async toggleMute() { calls.mute += 1; },
    async switchCamera() { calls.switch += 1; },
    async toggleVideo() { calls.video += 1; if (options.videoGate) await options.videoGate; },
    async selectAudioRoute(id) { calls.routes.push(id); if (options.routeGate) await options.routeGate; },
    async dismiss() { calls.dismiss += 1; },
    ...options.provider,
  };
  const createMedia = () => ({
    muted: undefined, srcObject: undefined,
    play() { calls.plays += 1; return options.play ? options.play(calls.plays) : Promise.resolve(); },
    pause() { calls.pauses += 1; },
  });
  const media = createMedia();
  const mediaByTag = {};
  let currentMedia = media;
  const react = {
    createElement(type, attributes, ...children) {
      if ((type === 'video' || type === 'audio') && attributes?.ref) {
        currentMedia = options.distinctMedia ? mediaByTag[type] ||= createMedia() : media;
        attributes.ref.current = currentMedia;
      }
      return { type, props: { ...attributes, children } };
    },
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
  const mocks = {
    react,
    'react-native': {
      ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', ScrollView: 'ScrollView', Text: 'Text',
      TouchableOpacity: 'TouchableOpacity', View: 'View', Platform: { OS: options.platform || 'web' },
      StyleSheet: { create: (value) => value },
    },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    './CallsProvider': { useCalls: () => provider },
    './nativeRtc': { getNativeRtcView() { calls.views += 1; return 'RTCView'; } },
    './callPresentation': presentationModule.exports,
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    Date: class extends Date { static now() { return options.now ? options.now() : Date.now(); } },
    setInterval(callback) { timers.add(callback); return callback; },
    clearInterval(callback) { timers.delete(callback); },
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock: ${name}`); return mocks[name]; },
  }, { filename });
  const Component = module.exports[options.component || 'default'];
  const render = () => {
    let tree;
    do {
      cursor = 0; dirty = false; effects = [];
      tree = Component(props);
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  };
  render();
  return {
    render, calls, get media() { return currentMedia; }, timers, exports: module.exports,
    tick() { timers.forEach((callback) => callback()); return render(); },
    button: (name) => nodes(render(), (node) => node.props.accessibilityLabel === name)[0],
    setProvider(next) { provider = { ...provider, ...next }; return render(); },
    setProps(next) { props = next; return render(); },
    close() { return nodes(render(), (node) => node.type === 'Modal')[0].props.onRequestClose(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

const incoming = { id: 'call-1', status: 'ringing', kind: 'video', direction: 'incoming', peer: { username: 'friend', name: 'Amiga' } };

test('an incoming call never answers or captures automatically and can be rejected while accepting permissions', async () => {
  const accepting = deferred();
  const h = harness({ call: incoming, acceptGate: accepting.promise });
  assert.match(textContent(h.render()), /Videollamada entrante/);
  assert.equal(h.calls.accept, 0);
  const accept = h.button('Aceptar llamada').props.onPress;
  const pending = accept();
  await accept();
  assert.equal(h.calls.accept, 1);
  assert.equal(h.button('Aceptar llamada').props.disabled, true);
  assert.equal(h.button('Rechazar llamada').props.disabled, false);
  await h.button('Rechazar llamada').props.onPress();
  assert.equal(h.calls.reject, 1);
  accepting.resolve();
  await pending;
});

test('preparing calls stay honest and permit cancellation even before a call id exists', async () => {
  const h = harness({ call: { ...incoming, id: null, status: 'preparing', direction: 'outgoing' } });
  assert.match(textContent(h.render()), /Preparando llamada/);
  assert.doesNotMatch(textContent(h.render()), /Esperando respuesta|Llamada en curso/);
  await h.button('Cancelar llamada').props.onPress();
  assert.equal(h.calls.end, 1);
  h.setProvider({ call: { ...incoming, preparing: true } });
  assert.equal(h.button('Aceptar llamada').props.disabled, true);
  assert.equal(h.button('Rechazar llamada').props.disabled, false);
  await h.close();
  assert.equal(h.calls.reject, 1);
});

test('a permission failure arriving after rejection cannot display an error in the completed call', async () => {
  const accepting = deferred();
  const h = harness({ call: incoming, acceptGate: accepting.promise });
  const pending = h.button('Aceptar llamada').props.onPress();
  await h.button('Rechazar llamada').props.onPress();
  h.setProvider({ call: { ...incoming, status: 'ended', reason: 'rejected' } });
  accepting.reject(new Error('Old permission request failed'));
  await pending;
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 0);
});

test('unavailable or disconnected calls explain the disabled answer while rejection remains possible', async () => {
  const h = harness({ call: incoming, provider: { availability: { available: false, reason: 'Expo Go no incluye las llamadas.' } } });
  assert.equal(h.button('Aceptar llamada').props.disabled, true);
  assert.match(textContent(h.render()), /Expo Go/);
  await h.button('Aceptar llamada').props.onPress();
  assert.equal(h.calls.accept, 0);
  assert.equal(h.calls.views, 0);
  h.setProvider({ availability: { available: true }, connected: false });
  assert.match(textContent(h.render()), /Sin conexión/);
  assert.equal(h.button('Aceptar llamada').props.disabled, true);
  await h.button('Rechazar llamada').props.onPress();
  assert.equal(h.calls.reject, 1);
});

test('active controls reflect provider mute state, show camera only for video and always permit hangup', async () => {
  const h = harness({ call: { ...incoming, status: 'active', direction: 'outgoing', kind: 'audio', muted: false } });
  assert.match(textContent(h.render()), /Llamada en curso/);
  assert.equal(h.button('Cambiar cámara de la llamada'), undefined);
  await h.button('Silenciar micrófono de la llamada').props.onPress();
  assert.equal(h.calls.mute, 1);
  h.setProvider({ call: { ...incoming, status: 'active', muted: true } });
  assert.ok(h.button('Activar micrófono de la llamada'));
  await h.button('Cambiar cámara de la llamada').props.onPress();
  assert.equal(h.calls.switch, 1);
  await h.button('Colgar llamada').props.onPress();
  assert.equal(h.calls.end, 1);
});

test('remote video and audio each mount one receiver, local preview stays muted and end unmounts all media', () => {
  const remoteStream = { marker: 'remote' };
  const localStream = { marker: 'local' };
  const h = harness({ call: { ...incoming, status: 'active', remoteStream, localStream, frontCamera: false } });
  const streams = nodes(h.render(), (node) => node.type === h.exports.CallStream);
  assert.equal(streams.length, 2);
  assert.equal(streams[0].props.stream, remoteStream);
  assert.equal(streams[0].props.video, true);
  assert.equal(streams[1].props.local, true);
  assert.equal(streams[1].props.mirror, false);
  h.setProvider({ call: { ...incoming, status: 'active', kind: 'audio', remoteStream, localStream } });
  const audio = nodes(h.render(), (node) => node.type === h.exports.CallStream);
  assert.equal(audio.length, 1);
  assert.equal(audio[0].props.stream, remoteStream);
  assert.equal(audio[0].props.video, false);
  h.setProvider({ call: { ...incoming, status: 'ended', reason: 'rejected' } });
  assert.equal(nodes(h.render(), (node) => node.type === h.exports.CallStream).length, 0);
  assert.match(textContent(h.render()), /fue rechazada/);
});

test('ended and preflight error states dismiss without accepting or ending a new call', async () => {
  const h = harness({ error: 'No se pudo acceder al micrófono.' });
  assert.equal(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert').length, 1);
  await h.button('Cerrar llamada').props.onPress();
  assert.equal(h.calls.dismiss, 1);
  h.setProvider({ error: null, call: { ...incoming, status: 'ended', reason: 'Permite el acceso al micrófono para iniciar la llamada.' } });
  assert.match(textContent(h.render()), /Permite el acceso al micrófono para iniciar la llamada/);
  assert.match(textContent(h.render()), /permisos del sitio/);
  await h.button('Cerrar llamada').props.onPress();
  assert.equal(h.calls.dismiss, 2);
  h.setProvider({ error: null, call: null });
  assert.equal(h.render(), null);
  assert.equal(h.calls.accept, 0);
  assert.equal(h.calls.end, 0);
});

test('local web video is muted before playback and detaches without stopping provider-owned tracks', async () => {
  let trackStops = 0;
  const stream = { getTracks: () => [{ stop: () => { trackStops += 1; } }] };
  const h = harness({ component: 'WebCallStream', props: { stream, video: true, local: true, mirror: true } });
  const video = nodes(h.render(), (node) => node.type === 'video')[0];
  assert.equal(video.props.muted, true);
  assert.equal(video.props.playsInline, true);
  assert.equal(h.media.muted, true);
  assert.equal(h.media.srcObject, stream);
  assert.equal(h.calls.plays, 1);
  h.unmount();
  assert.equal(h.media.srcObject, null);
  assert.equal(h.calls.pauses, 1);
  assert.equal(trackStops, 0);
});

test('remote web audio autoplay rejection exposes an explicit sound action and retries only on a tap', async () => {
  const h = harness({ component: 'WebCallStream', props: { stream: {}, video: false }, play: (attempt) => attempt === 1 ? Promise.reject(new Error('Autoplay blocked')) : Promise.resolve() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.media.muted, false);
  assert.equal(nodes(h.render(), (node) => node.type === 'audio').length, 1);
  assert.equal(h.calls.plays, 1);
  assert.match(textContent(h.render()), /navegador bloqueó el sonido/);
  await h.button('Activar sonido de la llamada').props.onPress();
  assert.equal(h.calls.plays, 2);
  assert.equal(h.button('Activar sonido de la llamada'), undefined);
});

test('a remote stream replacement ignores an old autoplay failure and retains only the current receiver', async () => {
  const firstPlayback = deferred();
  const original = { marker: 'audio-before-video' };
  const replacement = { marker: 'audio-and-video' };
  const h = harness({ component: 'WebCallStream', props: { stream: original, video: true },
    play: (attempt) => attempt === 1 ? firstPlayback.promise : Promise.resolve() });
  h.setProps({ stream: replacement, video: true });
  firstPlayback.reject(new Error('Old receiver aborted playback'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.media.srcObject, replacement);
  assert.equal(h.media.muted, false);
  assert.equal(nodes(h.render(), (node) => node.type === 'video').length, 1);
  assert.equal(nodes(h.render(), (node) => node.type === 'audio').length, 0);
  assert.equal(h.button('Activar sonido de la llamada'), undefined);
  assert.equal(h.calls.plays, 2);
  h.unmount();
  assert.equal(h.media.srcObject, null);
});

test('native RTCView uses its stream URL and mirrors only the local camera', () => {
  const h = harness({ component: 'CallStream', platform: 'android', props: { stream: { toURL: () => 'remote-url' }, video: true, mirror: true } });
  assert.equal(h.render().props.streamURL, 'remote-url');
  assert.equal(h.render().props.mirror, false);
  h.setProps({ stream: { toURL: () => 'local-url' }, video: true, local: true, mirror: true });
  assert.equal(h.render().props.streamURL, 'local-url');
  assert.equal(h.render().props.mirror, true);
  h.setProps({ stream: {}, video: false });
  assert.equal(h.render(), null);
});

test('live duration uses the confirmed activeAt timestamp, advances without provider changes and stops at the server duration', () => {
  const activeAt = '2026-10-09T12:00:00Z';
  let now = Date.parse(activeAt) + 65000;
  const h = harness({ component: 'CallDuration', props: { activeAt, active: true }, now: () => now });
  assert.match(textContent(h.render()), /01:05/);
  assert.equal(h.timers.size, 1);
  now += 3000;
  assert.match(textContent(h.tick()), /01:08/);
  h.setProps({ activeAt, active: false, durationSeconds: 70 });
  assert.equal(h.timers.size, 0);
  now += 10000;
  assert.match(textContent(h.tick()), /01:10/);
  assert.equal(h.calls.accept + h.calls.end, 0);
  h.unmount();
  assert.equal(h.timers.size, 0);
});

test('duration never invents a start time or displays invalid or negative durations', () => {
  const h = harness({ component: 'CallDuration', props: { activeAt: null, active: true } });
  assert.equal(h.render(), null);
  assert.equal(h.timers.size, 0);
  h.setProps({ activeAt: 'invalid', active: true });
  assert.equal(h.render(), null);
  h.setProps({ activeAt: '0', active: true });
  assert.equal(h.render(), null);
  h.setProps({ active: false, durationSeconds: -1 });
  assert.equal(h.render(), null);
  h.setProps({ active: false, durationSeconds: 0 });
  assert.match(textContent(h.render()), /00:00/);
});

test('video controls follow confirmed state, prevent duplicate toggles and retain remote audio when both cameras stop', async () => {
  const changing = deferred();
  const remoteStream = { marker: 'remote' }; const localStream = { marker: 'local' };
  const activeCall = { ...incoming, status: 'active', remoteStream, localStream, videoEnabled: true };
  const h = harness({ call: activeCall, videoGate: changing.promise });
  const toggle = h.button('Desactivar video de la llamada').props.onPress;
  const pending = toggle();
  assert.equal(await toggle(), false);
  assert.equal(h.calls.video, 1);
  assert.equal(h.button('Cambiar cámara de la llamada').props.disabled, true);
  assert.ok(h.button('Desactivar video de la llamada'));
  changing.resolve(); await pending;
  assert.ok(h.button('Desactivar video de la llamada'), 'The UI does not assume native success before the provider confirms it');
  h.setProvider({ call: { ...activeCall, videoEnabled: false, remoteVideoEnabled: false } });
  assert.ok(h.button('Activar video de la llamada'));
  assert.match(textContent(h.render()), /Tu video está desactivado/);
  assert.match(textContent(h.render()), /otra persona desactivó su video/);
  const receivers = nodes(h.render(), (node) => node.type === h.exports.CallStream);
  assert.equal(receivers.length, 1);
  assert.equal(receivers[0].props.stream, remoteStream);
  assert.equal(receivers[0].props.video, false);
  assert.equal(h.button('Cambiar cámara de la llamada').props.disabled, true);
  await h.button('Cambiar cámara de la llamada').props.onPress();
  assert.equal(h.calls.switch, 0);
  h.setProvider({ call: { ...activeCall, kind: 'audio' } });
  assert.equal(h.button('Desactivar video de la llamada'), undefined);
});

test('audio output lists only discovered routes, waits for native confirmation and leaves hangup available after route errors', async () => {
  const selecting = deferred();
  const h = harness({ call: { ...incoming, status: 'active', kind: 'audio' }, routeGate: selecting.promise });
  assert.equal(h.button('Usar Altavoz'), undefined);
  h.setProvider({ audioRoutes: [{ id: 'earpiece', label: 'Auricular', type: 'earpiece' },
    { id: 'speaker', label: 'Altavoz', type: 'speaker' }], audioRoute: 'earpiece' });
  assert.equal(h.button('Usar Auricular').props.accessibilityState.selected, true);
  const route = h.button('Usar Altavoz').props.onPress;
  const pending = route(); await route();
  assert.deepEqual(h.calls.routes, ['speaker']);
  assert.equal(h.button('Usar Auricular').props.accessibilityState.selected, true);
  assert.equal(h.button('Colgar llamada').props.disabled, false);
  selecting.resolve(); await pending;
  h.setProvider({ audioRoute: 'speaker' });
  assert.equal(h.button('Usar Altavoz').props.accessibilityState.selected, true);
  h.setProvider({ audioRouteError: 'No se pudo cambiar la salida de audio.' });
  assert.match(textContent(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert')[0]), /salida de audio/);
  await h.button('Colgar llamada').props.onPress();
  assert.equal(h.calls.end, 1);
});

test('switching a remote receiver between audio and video reattaches srcObject and detaches the previous DOM element', () => {
  const stream = { marker: 'same-remote-stream' };
  const h = harness({ component: 'WebCallStream', distinctMedia: true, props: { stream, video: false } });
  const audio = h.media;
  assert.equal(audio.srcObject, stream);
  h.setProps({ stream, video: true });
  const video = h.media;
  assert.notEqual(video, audio);
  assert.equal(audio.srcObject, null);
  assert.equal(video.srcObject, stream);
  assert.equal(video.muted, false);
  assert.equal(nodes(h.render(), (node) => node.type === 'video').length, 1);
  assert.equal(nodes(h.render(), (node) => node.type === 'audio').length, 0);
  h.setProps({ stream, video: false });
  assert.equal(video.srcObject, null);
  assert.equal(h.media.srcObject, stream);
  assert.equal(nodes(h.render(), (node) => node.type === 'audio').length, 1);
  assert.equal(h.calls.plays, 3);
});
