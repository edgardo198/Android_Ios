const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let nextId = 0;
function track(kind) {
  return {
    id: `${kind}-${++nextId}`, kind, enabled: true, readyState: 'live', stops: 0,
    stop() { this.stops += 1; this.readyState = 'ended'; },
  };
}
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks]; this.id = `stream-${++nextId}`; this.releases = []; }
  getTracks() { return this.tracks.slice(); }
  getAudioTracks() { return this.tracks.filter((item) => item.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((item) => item.kind === 'video'); }
  addTrack(item) { if (!this.tracks.includes(item)) this.tracks.push(item); }
  removeTrack(item) { this.tracks = this.tracks.filter((existing) => existing !== item); }
  toURL() { return this.id; }
  release(releaseTracks = true) { this.releases.push(releaseTracks); if (releaseTracks) this.tracks.forEach((item) => item.stop()); }
}
const mediaStream = (video = false) => new Stream([track('audio'), ...(video ? [track('video')] : [])]);
const candidate = (id = 'one') => ({ candidate: `candidate:${id}`, sdpMid: '0', sdpMLineIndex: 0 });

function harness(options = {}) {
  const calls = { captures: [], nativeCaptures: [], peers: [], leases: [], nativeReads: 0 };
  class Peer {
    constructor(config) {
      this.config = config; this.tracks = []; this.candidates = []; this.descriptions = [];
      this.offers = 0; this.answers = 0; this.closes = 0;
      this.connectionState = 'new'; this.iceConnectionState = 'new';
      this._pcId = 100 + calls.peers.length;
      calls.peers.push(this);
    }
    addTrack(item, stream) {
      const sender = { track: item, replacements: [], replaceTrack: async (next) => {
        sender.replacements.push(next);
        if (options.replaceTrack) await options.replaceTrack(next);
        sender.track = next;
      } };
      this.tracks.push({ track: item, stream, sender });
      return sender;
    }
    async createOffer() { this.offers += 1; return options.createOffer ? options.createOffer() : { type: 'offer', sdp: 'local-offer' }; }
    async createAnswer() { this.answers += 1; return options.createAnswer ? options.createAnswer() : { type: 'answer', sdp: 'local-answer' }; }
    async setLocalDescription(value) {
      if (options.setLocalDescription) await options.setLocalDescription(value);
      this.localDescription = value; this.descriptions.push(['local', value]);
    }
    async setRemoteDescription(value) {
      if (options.setRemoteDescription) await options.setRemoteDescription(value);
      this.remoteDescription = value; this.descriptions.push(['remote', value]);
    }
    async addIceCandidate(value) {
      if (options.addIceCandidate) await options.addIceCandidate(value);
      this.candidates.push(value);
    }
    close() { this.closes += 1; this.connectionState = 'closed'; }
  }
  const native = {
    getNativeRtcAvailability() { return options.unavailable ? { available: false, reason: 'Abre la app instalada.' } : { available: true, reason: null }; },
    getNativeRtcEngine() { calls.nativeReads += 1; return { RTCPeerConnection: Peer, MediaStream: Stream }; },
    async startLocalCapture(constraints) {
      calls.nativeCaptures.push(constraints);
      if (options.nativeCapture) return options.nativeCapture(constraints);
      const stream = options.stream || mediaStream(constraints.video);
      let stopped = false;
      const lease = {
        stream, stops: 0,
        stop() { if (stopped) return; stopped = true; this.stops += 1; stream.getTracks().forEach((item) => item.stop()); },
        setMicrophoneEnabled(value) { if (stopped) return false; stream.getAudioTracks().forEach((item) => { item.enabled = Boolean(value); }); return true; },
        switchCamera: options.switchCamera || (async () => true),
      };
      constraints.signal.addEventListener('abort', () => lease.stop(), { once: true });
      calls.leases.push(lease);
      return lease;
    },
  };
  const navigator = { mediaDevices: { async getUserMedia(constraints) {
    calls.captures.push(constraints);
    return options.capture ? options.capture(constraints) : options.stream || mediaStream(Boolean(constraints.video));
  } } };
  const filename = path.join(__dirname, '..', 'src/calls/rtcSession.js');
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false, plugins: [require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Promise, AbortController,
    navigator: options.noMediaDevices ? {} : navigator,
    RTCPeerConnection: options.noPeer ? undefined : Peer,
    MediaStream: options.noStream ? undefined : Stream, isSecureContext: options.secure !== false,
    require(name) {
      if (name === 'react-native') return { Platform: { OS: options.os || 'web' } };
      if (name === './nativeRtc') return native;
      throw new Error(`Missing mock ${name}`);
    },
  }, { filename });
  return { api: module.exports, calls };
}

test('availability checks do not capture and reject insecure web or missing RTC before any permission prompt', async () => {
  for (const options of [{ secure: false }, { noMediaDevices: true }, { noPeer: true }, { noStream: true }, { os: 'android', unavailable: true }]) {
    const h = harness(options);
    assert.equal(h.api.getCallAvailability().available, false);
    await assert.rejects(h.api.createRtcSession({ kind: 'audio' }), { code: 'CALL_UNAVAILABLE' });
    assert.equal(h.calls.captures.length + h.calls.nativeCaptures.length, 0);
    assert.equal(h.calls.nativeReads, 0);
    if (options.secure === false) {
      assert.match(h.api.getCallAvailability().reason, /HTTPS/);
      assert.match(h.api.getCallAvailability().reason, /localhost/);
    }
  }
  for (const os of ['web', 'android', 'ios']) {
    const h = harness({ os });
    assert.equal(h.api.getCallAvailability().available, true);
    assert.equal(h.calls.captures.length + h.calls.nativeCaptures.length, 0);
  }
});

test('web audio captures only audio, adds live local tracks and uses no public ICE service by default', async () => {
  const stream = mediaStream();
  const local = [];
  const states = [];
  const h = harness({ stream });
  const session = await h.api.createRtcSession({ kind: 'audio', onLocalStream: (value) => local.push(value), onConnectionState: (value) => states.push(value) });
  assert.deepEqual(plain(h.calls.captures), [{ audio: true, video: false }]);
  assert.deepEqual(plain(h.calls.peers[0].config), { iceServers: [] });
  assert.equal(h.calls.peers[0].tracks[0].stream, stream);
  assert.deepEqual(local, [stream]);
  assert.equal(session.setMicrophoneEnabled(false), true);
  assert.equal(stream.getAudioTracks()[0].enabled, false);
  assert.equal(await session.switchCamera(), false);
  session.close(); session.close();
  assert.equal(stream.getTracks()[0].stops, 1);
  assert.equal(h.calls.peers[0].closes, 1);
  assert.equal(session.setMicrophoneEnabled(true), false);
  assert.deepEqual(states, ['new', 'closed']);
});

test('native calls request an exclusive lease, preserve explicit ICE config and stop only their own lease', async () => {
  const stream = mediaStream(true);
  const h = harness({ os: 'android', stream });
  const servers = [{ urls: ['stun:192.168.1.2:3478'] }];
  const session = await h.api.createRtcSession({ kind: 'video', iceServers: servers });
  assert.equal(h.calls.captures.length, 0);
  assert.equal(h.calls.nativeCaptures[0].exclusive, true);
  assert.equal(h.calls.nativeCaptures[0].video, true);
  assert.deepEqual(plain(h.calls.peers[0].config), { iceServers: servers });
  assert.equal(session.setMicrophoneEnabled(false), true);
  assert.equal(stream.getAudioTracks()[0].enabled, false);
  assert.equal(await session.switchCamera(), true);
  session.close(); session.close();
  assert.equal(h.calls.leases[0].stops, 1);
  stream.getTracks().forEach((item) => assert.equal(item.stops, 1));
});

test('permission rejection and partial capture are translated and release acquired tracks without opening a peer', async () => {
  const denied = harness({ capture: () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); } });
  await assert.rejects(denied.api.createRtcSession({ kind: 'audio' }), (error) => error.code === 'CALL_PERMISSION_DENIED' && /micrófono/.test(error.message));
  assert.equal(denied.calls.peers.length, 0);
  const partial = mediaStream();
  const h = harness({ stream: partial });
  await assert.rejects(h.api.createRtcSession({ kind: 'video' }), { code: 'CALL_CAPTURE_FAILED' });
  assert.equal(partial.getTracks()[0].stops, 1);
  assert.equal(h.calls.peers.length, 0);
});

test('pre-aborted capture never requests devices and late browser capture is stopped after cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  const initial = harness();
  await assert.rejects(initial.api.createRtcSession({ kind: 'audio', signal: controller.signal }), { code: 'CALL_CANCELLED' });
  assert.equal(initial.calls.captures.length, 0);
  const pending = deferred();
  const stream = mediaStream(true);
  const h = harness({ capture: () => pending.promise });
  const active = new AbortController();
  const starting = h.api.createRtcSession({ kind: 'video', signal: active.signal });
  const rejected = assert.rejects(starting, { code: 'CALL_CANCELLED' });
  active.abort(); active.abort(); pending.resolve(stream);
  await rejected;
  stream.getTracks().forEach((item) => assert.equal(item.stops, 1));
  assert.equal(h.calls.peers.length, 0);
});

test('late native leases are closed even if an engine returns a stream after its abort signal', async () => {
  const pending = deferred();
  const stream = mediaStream();
  let stops = 0;
  const h = harness({ os: 'android', nativeCapture: () => pending.promise });
  const controller = new AbortController();
  const starting = h.api.createRtcSession({ kind: 'audio', signal: controller.signal });
  const rejected = assert.rejects(starting, { code: 'CALL_CANCELLED' });
  controller.abort();
  assert.equal(h.calls.nativeCaptures[0].signal.aborted, true);
  pending.resolve({ stream, stop() { stops += 1; } });
  await rejected;
  assert.equal(stops, 1);
  assert.equal(h.calls.peers.length, 0);
});

test('caller creates exactly one offer, accepts one answer and never emits SDP via ICE callback', async () => {
  const signals = [];
  const h = harness();
  const session = await h.api.createRtcSession({ kind: 'audio', onSignal: (value) => signals.push(value) });
  const first = session.offer();
  assert.equal(session.offer(), first);
  assert.deepEqual(plain(await first), { type: 'offer', sdp: 'local-offer' });
  const answer = { type: 'answer', sdp: 'remote-answer' };
  const received = session.receiveDescription(answer);
  assert.equal(session.receiveDescription(answer), received);
  assert.equal(await received, null);
  assert.equal(h.calls.peers[0].offers, 1);
  assert.equal(h.calls.peers[0].answers, 0);
  assert.deepEqual(signals, []);
  await assert.rejects(session.receiveDescription({ type: 'offer', sdp: 'glare' }), { code: 'CALL_DESCRIPTION_CONFLICT' });
  session.close();
});

test('callee waits for remote SDP, drains early ICE in order and returns one cached answer', async () => {
  const remote = deferred();
  const h = harness({ setRemoteDescription: () => remote.promise });
  const session = await h.api.createRtcSession({ kind: 'video' });
  assert.equal(await session.addCandidate(candidate('early')), true);
  assert.equal(await session.addCandidate(candidate('early')), true);
  assert.equal(await session.addCandidate(null), false);
  const offer = { type: 'offer', sdp: 'remote-offer' };
  const received = session.receiveDescription(offer);
  assert.equal(session.receiveDescription(offer), received);
  await flush();
  assert.equal(h.calls.peers[0].candidates.length, 0);
  await session.addCandidate(candidate('during-remote'));
  remote.resolve();
  assert.deepEqual(plain(await received), { type: 'answer', sdp: 'local-answer' });
  await session.addCandidate(candidate('late'));
  assert.deepEqual(plain(h.calls.peers[0].candidates), [candidate('early'), candidate('during-remote'), candidate('late')]);
  assert.equal(h.calls.peers[0].answers, 1);
  await assert.rejects(session.offer(), { code: 'CALL_DESCRIPTION_CONFLICT' });
  session.close();
});

test('ICE events serialize to backend candidate signals, reject invalid candidates and bound buffered signals', async () => {
  const signals = [];
  const h = harness();
  const session = await h.api.createRtcSession({ kind: 'audio', onSignal: (value) => signals.push(value) });
  h.calls.peers[0].onicecandidate({ candidate: { toJSON: () => candidate('outgoing') } });
  h.calls.peers[0].onicecandidate({ candidate: null });
  assert.deepEqual(plain(signals), [{ type: 'candidate', candidate: candidate('outgoing') }]);
  await assert.rejects(session.addCandidate({ candidate: 'candidate:bad' }), { code: 'CALL_INVALID_CANDIDATE' });
  await assert.rejects(session.receiveDescription({ type: 'answer', sdp: 'unordered' }), { code: 'CALL_DESCRIPTION_CONFLICT' });
  await assert.rejects(session.receiveDescription({ type: 'offer', sdp: '' }), { code: 'CALL_INVALID_DESCRIPTION' });
  for (let index = 0; index < 256; index += 1) await session.addCandidate(candidate(String(index)));
  await assert.rejects(session.addCandidate(candidate('overflow')), { code: 'CALL_CANDIDATE_LIMIT' });
  assert.equal(h.calls.peers[0].candidates.length, 0);
  session.close();
});

test('streamless remote audio then video produce fresh renderable containers and release each track once', async () => {
  for (const os of ['web', 'android']) {
    const remote = [];
    const h = harness({ os });
    const session = await h.api.createRtcSession({ kind: 'video', onRemoteStream: (value) => remote.push(value) });
    const peer = h.calls.peers[0];
    const audio = track('audio'); const video = track('video');
    const handler = peer.ontrack;
    handler({ track: audio, streams: [] });
    handler({ track: video, streams: [new Stream([audio, video])] });
    handler({ track: video, streams: [] });
    assert.equal(remote.length, 2);
    assert.notEqual(remote[0].toURL(), remote[1].toURL());
    assert.deepEqual(remote[1].getTracks(), [audio, video]);
    session.close(); session.close();
    assert.equal(audio.stops, 1); assert.equal(video.stops, 1);
    remote.forEach((stream) => assert.deepEqual(stream.releases, [false]));
    handler({ track: track('audio'), streams: [] });
    assert.equal(remote.length, 2);
  }
});

test('connection changes deduplicate ICE fallbacks and consumer signaling failure releases the session', async () => {
  const states = [];
  const h = harness();
  const session = await h.api.createRtcSession({ kind: 'audio', onSignal: () => false, onConnectionState: (state, error) => states.push([state, error?.code]) });
  const peer = h.calls.peers[0];
  delete peer.connectionState;
  peer.iceConnectionState = 'checking'; peer.oniceconnectionstatechange(); peer.onconnectionstatechange();
  peer.iceConnectionState = 'completed'; peer.oniceconnectionstatechange();
  peer.onicecandidate({ candidate: candidate('cannot-send') });
  assert.deepEqual(states, [['new', undefined], ['connecting', undefined], ['connected', undefined], ['failed', 'CALL_SIGNAL_FAILED'], ['closed', undefined]]);
  assert.equal(peer.closes, 1);
  session.close();
  assert.equal(peer.closes, 1);
});

test('native and browser ICE connectivity cannot publish active before the aggregated DTLS state is connected', async () => {
  for (const os of ['web', 'android']) {
    const states = [];
    const h = harness({ os });
    const session = await h.api.createRtcSession({ kind: 'audio', onConnectionState: (state) => states.push(state) });
    const peer = h.calls.peers[0];
    peer.iceConnectionState = 'completed';
    peer.oniceconnectionstatechange();
    assert.deepEqual(states, ['new']);
    peer.connectionState = 'connecting';
    peer.onconnectionstatechange();
    peer.oniceconnectionstatechange();
    assert.deepEqual(states, ['new', 'connecting']);
    peer.connectionState = 'connected';
    peer.onconnectionstatechange();
    peer.oniceconnectionstatechange();
    assert.deepEqual(states, ['new', 'connecting', 'connected']);
    session.close();
  }
});

test('closing during an SDP operation prevents late local description and candidate callbacks', async () => {
  const offer = deferred();
  const signals = [];
  const h = harness({ createOffer: () => offer.promise });
  const session = await h.api.createRtcSession({ kind: 'audio', onSignal: (value) => signals.push(value) });
  const pending = session.offer();
  const rejected = assert.rejects(pending, { code: 'CALL_CANCELLED' });
  await flush();
  const ice = h.calls.peers[0].onicecandidate;
  session.close();
  offer.resolve({ type: 'offer', sdp: 'late' });
  ice({ candidate: candidate('late') });
  await rejected;
  assert.deepEqual(h.calls.peers[0].descriptions, []);
  assert.deepEqual(signals, []);
  await assert.rejects(session.addCandidate(candidate('closed')), { code: 'CALL_CANCELLED' });
});

test('web camera replacement preserves the audio track and stops the old camera only after replacement', async () => {
  const original = mediaStream(true);
  const next = new Stream([track('video')]);
  const replaced = deferred();
  let captures = 0;
  const h = harness({ capture: () => (++captures === 1 ? original : next), replaceTrack: () => replaced.promise });
  const local = [];
  const session = await h.api.createRtcSession({ kind: 'video', onLocalStream: (stream) => local.push(stream) });
  const oldVideo = original.getVideoTracks()[0];
  const audio = original.getAudioTracks()[0];
  const change = session.switchCamera();
  assert.equal(session.switchCamera(), change);
  await flush();
  assert.equal(oldVideo.stops, 0);
  assert.deepEqual(plain(h.calls.captures[1]), { audio: false, video: { facingMode: { exact: 'environment' } } });
  replaced.resolve();
  assert.equal(await change, true);
  assert.equal(oldVideo.stops, 1);
  assert.equal(audio.stops, 0);
  assert.equal(original.getVideoTracks()[0], next.getVideoTracks()[0]);
  assert.equal(local.length, 2);
  session.close();
  assert.equal(audio.stops, 1);
  assert.equal(next.getVideoTracks()[0].stops, 1);
});

test('failed camera replacement keeps the original track and lets the user retry', async () => {
  const original = mediaStream(true);
  const attempts = [];
  let captures = 0; let replacements = 0;
  const h = harness({
    capture: () => { if (++captures === 1) return original; const stream = new Stream([track('video')]); attempts.push(stream); return stream; },
    replaceTrack: () => { if (++replacements === 1) throw new Error('Device failed'); },
  });
  const session = await h.api.createRtcSession({ kind: 'video' });
  const old = original.getVideoTracks()[0];
  await assert.rejects(session.switchCamera(), (error) => error.code === 'CALL_CAMERA_SWITCH_FAILED' && /cámara/.test(error.message));
  assert.equal(attempts[0].getTracks()[0].stops, 1);
  assert.equal(old.stops, 0);
  assert.equal(original.getVideoTracks()[0], old);
  assert.equal(await session.switchCamera(), true);
  assert.equal(old.stops, 1);
  session.close();
});

test('cancelling during camera acquisition or replacement closes late camera tracks without republishing', async () => {
  for (const stage of ['capture', 'replace']) {
    const pending = deferred(); const original = mediaStream(true); const next = new Stream([track('video')]);
    const local = []; let captures = 0;
    const h = harness({
      capture: () => (++captures === 1 ? original : stage === 'capture' ? pending.promise : next),
      replaceTrack: () => stage === 'replace' ? pending.promise : undefined,
    });
    const session = await h.api.createRtcSession({ kind: 'video', onLocalStream: (stream) => local.push(stream) });
    const switching = session.switchCamera(); await flush();
    session.close(); pending.resolve(stage === 'capture' ? next : undefined);
    assert.equal(await switching, false);
    original.getTracks().forEach((item) => assert.equal(item.stops, 1));
    assert.equal(next.getTracks()[0].stops, 1);
    assert.equal(local.length, 1);
  }
});

test('native camera changes finishing after close never publish success', async () => {
  const pending = deferred();
  const h = harness({ os: 'android', switchCamera: () => pending.promise });
  const session = await h.api.createRtcSession({ kind: 'video' });
  const changing = session.switchCamera(); await flush();
  session.close(); pending.resolve(true);
  assert.equal(await changing, false);
  assert.equal(h.calls.leases[0].stops, 1);
});

test('camera toggles affect only live video tracks and closing prevents them from being re-enabled', async () => {
  for (const os of ['web', 'android']) {
    const stream = mediaStream(true); const audio = stream.getAudioTracks()[0]; const video = stream.getVideoTracks()[0];
    const h = harness({ os, stream });
    const session = await h.api.createRtcSession({ kind: 'video' });
    assert.equal(session.setCameraEnabled(false), true);
    assert.equal(video.enabled, false);
    assert.equal(audio.enabled, true);
    assert.equal(video.readyState, 'live');
    assert.equal(audio.readyState, 'live');
    assert.equal(session.setCameraEnabled(true), true);
    assert.equal(video.enabled, true);
    session.setCameraEnabled(false); session.close();
    assert.equal(session.setCameraEnabled(true), false);
    assert.equal(video.enabled, false);
    assert.equal(video.stops, 1); assert.equal(audio.stops, 1);
  }
  const h = harness(); const voice = await h.api.createRtcSession({ kind: 'audio' });
  assert.equal(voice.setCameraEnabled(false), false);
  voice.close();
});

test('native resource ownership contains only this peer and local tracks, never remote tracks or closed resources', async () => {
  const local = mediaStream(true); const remoteAudio = track('audio');
  const h = harness({ os: 'android', stream: local });
  const session = await h.api.createRtcSession({ kind: 'video' });
  h.calls.peers[0].ontrack({ track: remoteAudio, streams: [new Stream([remoteAudio])] });
  const resources = session.getNativeResourceIds();
  assert.equal(resources.peerConnectionId, h.calls.peers[0]._pcId);
  assert.equal(resources.streamId, local.toURL());
  assert.deepEqual(plain(resources.trackIds), local.getTracks().map((item) => item.id));
  assert(!resources.trackIds.includes(remoteAudio.id));
  session.close();
  assert.equal(session.getNativeResourceIds(), null);
  assert.equal(remoteAudio.stops, 1);
  const browser = harness(); const webSession = await browser.api.createRtcSession({ kind: 'audio' });
  assert.equal(webSession.getNativeResourceIds(), null);
  webSession.close();
});
