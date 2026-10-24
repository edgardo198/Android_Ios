const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 25; i += 1) await Promise.resolve(); }

function nativeService(options = {}) {
  const configurations = []; const leases = [];
  return { configurations, leases,
    async start(config) {
      configurations.push(config);
      const lease = { stops: 0, updates: [], routes: [],
        async stop() { this.stops += 1; },
        async update(value) { this.updates.push(value); if (options.update) return options.update(value); },
        async selectAudioRoute(id) { this.routes.push(id); return options.selectRoute ? options.selectRoute(id) : false; },
      };
      leases.push(lease);
      if (options.start) await options.start(config);
      return lease;
    },
  };
}

async function connectMedia(h, kind = 'audio') {
  await h.login();
  assert.equal(await h.client.startCall(1, kind, { username: 'bob' }), true);
  const accepted = h.outgoing({ kind, status: 'connecting', version: 2, acceptedDeviceId: 'bob-device' });
  h.setServerCall(accepted);
  h.sockets.at(-1).deliver({ type: 'call.state', call: accepted });
  await settle();
  h.captures.at(-1).onConnectionState('connected');
  assert.equal(h.client.getState().call.status, 'active');
}

test('shared call history invalidation preserves active media and ignores an old account socket', async () => {
  const h = harness();
  await connectMedia(h);
  const oldSocket = h.sockets.at(-1);
  const call = h.client.getState().call;
  oldSocket.deliver({ type: 'call.history.cleared', callIds: null, revision: 1 });
  assert.equal(h.client.getState().historyRevision, 1);
  assert.equal(h.client.getState().call.id, call.id);
  assert.equal(h.media.at(-1).closes, 0);
  await h.client.deactivate();
  oldSocket.deliver({ type: 'call.history.cleared', callIds: null, revision: 2 });
  assert.equal(h.client.getState().historyRevision, 0);
});

test('password recovery revocation immediately closes owned captures and signaling without reusing revoked credentials', async () => {
  const service = nativeService();
  const invalidations = [];
  const h = harness({ makeNativeSession: service.start, onAuthInvalidated: (data) => invalidations.push(data) });
  await connectMedia(h, 'video');
  const oldSocket = h.sockets.at(-1);
  const requestsBefore = h.requests.length;
  const sentBefore = oldSocket.sent.length;
  oldSocket.deliver({ type: 'auth.invalidated', authVersion: 1 });
  await settle();
  assert.equal(h.media.at(-1).closes, 1);
  assert.equal(service.leases.at(-1).stops, 1);
  assert.equal(oldSocket.readyState, 3);
  assert.equal(h.client.getState().connected, false);
  assert.equal(h.client.getState().call, null);
  assert.equal(h.requests.length, requestsBefore);
  assert.equal(oldSocket.sent.length, sentBefore);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(invalidations)), [{ username: 'alice', authVersion: 1 }]);
});

test('a stale or malformed recovery notification cannot close a newly authenticated call', async () => {
  const invalidations = [];
  const h = harness({ getAuthVersion: () => 2, onAuthInvalidated: (data) => invalidations.push(data) });
  await connectMedia(h);
  for (const authVersion of [undefined, null, '3', 0, -1, 1, 2, 2.5]) {
    h.sockets.at(-1).deliver({ type: 'auth.invalidated', authVersion });
  }
  assert.equal(h.media.at(-1).closes, 0);
  assert.equal(h.client.getState().call.status, 'active');
  assert.equal(invalidations.length, 0);
  const oldCallback = h.sockets.at(-1).onmessage;
  h.client.deactivate();
  await h.login();
  oldCallback({ data: JSON.stringify({ type: 'auth.invalidated', authVersion: 3 }) });
  assert.equal(h.client.getState().connected, true);
  assert.equal(invalidations.length, 0);
  h.client.deactivate();
});

function harness(options = {}) {
  const module = { exports: {} };
  const timers = new Map();
  let timerId = 0;
  const addTimer = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  const source = fs.readFileSync(path.join(__dirname, '../src/calls/callClient.js'), 'utf8')
    .replace('export function createCallClient', 'function createCallClient');
  vm.runInNewContext(`${source}\nmodule.exports = { createCallClient };`, {
    module, AbortController, setTimeout: addTimer, setInterval: addTimer,
    Date: { now: () => options.now ?? Date.now(), parse: Date.parse },
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
  });
  let identity = 'alice';
  let sequence = 0;
  let serverCall = null;
  const requests = [], sockets = [], captures = [], media = [], tokenRequests = [];
  const outgoing = (patch = {}) => ({ id: 'call-1', kind: 'audio', status: 'ringing', version: 1,
    caller: { username: 'alice' }, callee: { username: 'bob' }, callerDeviceId: 'id-1', acceptedDeviceId: null, ...patch });
  const client = module.exports.createCallClient({
    uuid: () => `id-${++sequence}`, availability: options.availability || { available: true, reason: null },
    getIdentity: () => identity, getToken: async (force) => { tokenRequests.push(force); return options.getToken ? options.getToken(force) : 'test-token'; },
    getAuthVersion: options.getAuthVersion,
    onAuthInvalidated: options.onAuthInvalidated,
    getWsUrl: async () => 'ws://localhost:8030', makeNativeSession: options.makeNativeSession,
    makeSocket(url) {
      const socket = { url, readyState: 0, sent: [],
        send(data) { this.sent.push(JSON.parse(data)); },
        close() { this.readyState = 3; this.onclose?.(); },
        open() { this.readyState = 1; this.onopen?.(); },
        deliver(data) { this.onmessage?.({ data: JSON.stringify(data) }); },
      };
      sockets.push(socket);
      return socket;
    },
    async request(method, url, data) {
      requests.push({ method, url, data, identity });
      if (options.request) return options.request(method, url, data);
      if (method === 'GET') return { call: serverCall, iceServers: [] };
      if (url === '/calls/') { serverCall = outgoing(); return { call: serverCall }; }
      if (data.action === 'accept') { serverCall = { ...serverCall, status: 'connecting', acceptedDeviceId: 'id-1', version: 2 }; return { call: serverCall }; }
      return { call: { ...serverCall, status: 'ended' } };
    },
    async makeRtc(callbacks) {
      captures.push(callbacks);
      const rtc = { closes: 0, offers: 0, mutes: [], videos: [],
        close() { this.closes += 1; },
        async offer() {
          this.offers += 1;
          callbacks.onSignal({ type: 'candidate', candidate: { candidate: 'test' } });
          return { type: 'offer', sdp: 'test-sdp' };
        },
        async receiveDescription(description) { return description.type === 'offer' ? { type: 'answer', sdp: 'answer-sdp' } : null; },
        async addCandidate() {},
        setMicrophoneEnabled(enabled) { this.mutes.push(enabled); return true; },
        setCameraEnabled(enabled) { this.videos.push(enabled); return true; },
        getNativeResourceIds() { return { peerConnectionId: 10, streamId: 'own-local-stream', trackIds: ['own-audio'] }; },
        async switchCamera() { return true; },
      };
      media.push(rtc);
      if (options.captureGate) await options.captureGate.promise;
      return rtc;
    },
  });
  return { client, requests, sockets, captures, media, timers, tokenRequests, outgoing,
    setIdentity: (next) => { identity = next; }, setServerCall: (call) => { serverCall = call; },
    async login() { client.activate(identity); await settle(); sockets.at(-1).open(); await settle(); },
  };
}

test('a ringing invitation never requests microphone until the recipient accepts', async () => {
  const h = harness(); await h.login();
  const invitation = h.outgoing({ caller: { username: 'bob' }, callee: { username: 'alice' }, callerDeviceId: 'other-device' });
  h.setServerCall(invitation); h.sockets[0].deliver({ type: 'call.state', call: invitation });
  assert.equal(h.client.getState().call.direction, 'incoming');
  assert.equal(h.captures.length, 0);
  await h.client.acceptCall();
  assert.equal(h.captures.length, 1);
  assert.equal(h.client.getState().call.status, 'connecting');
  h.client.deactivate();
});

test('cancelling during delayed capture closes its late lease without inviting a contact', async () => {
  const gate = deferred(); const h = harness({ captureGate: gate }); await h.login();
  const pending = h.client.startCall(1, 'audio', { username: 'bob' }); await settle();
  assert.equal(h.client.getState().call.status, 'preparing');
  await h.client.endCall(); gate.resolve(); await pending;
  assert.equal(h.media[0].closes, 1);
  assert.equal(h.captures[0].signal.aborted, true);
  assert.equal(h.requests.filter((request) => request.url === '/calls/').length, 0);
});

test('a late invitation after cancellation is terminated rather than reopened', async () => {
  const createGate = deferred(); let h;
  h = harness({ request: async (method, url) => url === '/calls/' ? createGate.promise : { call: null, iceServers: [] } });
  await h.login(); const pending = h.client.startCall(1, 'audio', { username: 'bob' }); await settle();
  await h.client.endCall();
  const call = h.outgoing(); h.sockets[0].deliver({ type: 'call.state', call });
  createGate.resolve({ call }); await pending;
  assert.equal(h.client.getState().call.status, 'ended');
  assert(h.sockets[0].sent.some((message) => message.type === 'call.end' && message.callId === call.id));
  assert.equal(h.media[0].closes, 1);
});

test('SDP precedes queued candidates and repeated accepted states generate only one offer', async () => {
  const h = harness(); await h.login(); await h.client.startCall(1, 'audio', { username: 'bob' });
  const accepted = h.outgoing({ status: 'connecting', version: 2, acceptedDeviceId: 'bob-device' });
  h.setServerCall(accepted);
  h.sockets[0].deliver({ type: 'call.state', call: accepted });
  h.sockets[0].deliver({ type: 'call.state', call: accepted }); await settle();
  const signals = h.sockets[0].sent.filter((message) => message.type === 'call.signal');
  assert.equal(h.media[0].offers, 1);
  assert.equal(signals[0].signal.type, 'offer');
  assert.equal(signals[1].signal.type, 'candidate');
  h.client.deactivate();
});

test('acceptance on another recipient device aborts pending capture and never sends end to that device', async () => {
  const gate = deferred(); const h = harness({ captureGate: gate }); await h.login();
  const invitation = h.outgoing({ caller: { username: 'bob' }, callee: { username: 'alice' }, callerDeviceId: 'bob-device' });
  h.setServerCall(invitation); h.sockets[0].deliver({ type: 'call.state', call: invitation });
  const pending = h.client.acceptCall(); await settle();
  h.sockets[0].deliver({ type: 'call.state', call: { ...invitation, status: 'connecting', version: 2, acceptedDeviceId: 'other-alice-device' } });
  gate.resolve(); await pending;
  assert.equal(h.media[0].closes, 1);
  assert.equal(h.requests.filter((request) => request.data?.action === 'accept').length, 0);
  assert(!h.sockets[0].sent.some((message) => message.type === 'call.end'));
  assert.match(h.client.getState().call.reason, /otro dispositivo/);
  h.client.deactivate();
});

test('socket loss before media connects stops capture and publishes an ended call', async () => {
  const h = harness(); await h.login(); await h.client.startCall(1, 'video', { username: 'bob' });
  h.sockets[0].close(); await settle();
  assert.equal(h.media[0].closes, 1);
  assert.equal(h.client.getState().connected, false);
  assert.equal(h.client.getState().call.status, 'ended');
  assert.match(h.client.getState().call.reason, /conexión/);
  h.client.deactivate();
});

test('connected audio and video survive signaling reconnection without recreating media', async () => {
  for (const kind of ['audio', 'video']) {
    const h = harness(); await connectMedia(h, kind);
    h.sockets[0].close(); await settle();
    assert.equal(h.media[0].closes, 0);
    assert.equal(h.client.getState().connected, false);
    const deadline = [...h.timers.values()].find(timer => timer.delay === 20000);
    assert(deadline);
    [...h.timers.values()].find(timer => timer.delay === 3000).callback();
    await settle(); h.sockets[1].open(); await settle();
    assert.equal(h.client.getState().connected, true);
    assert.equal(h.media.length, 1);
    assert.equal(h.media[0].closes, 0);
    assert(h.sockets[1].sent.some(message => message.type === 'call.connected'));
    assert(![...h.timers.values()].includes(deadline));
    // A second outage must get a fresh deadline after the first recovery.
    h.sockets[1].close(); await settle();
    const nextDeadline = [...h.timers.values()].find(timer => timer.delay === 20000);
    assert(nextDeadline);
    nextDeadline.callback(); await settle();
    assert.equal(h.media[0].closes, 1);
    assert.equal(h.client.getState().call.status, 'ended');
    h.client.deactivate();
  }
});

test('logout during signaling recovery cancels the recovery deadline and closes media', async () => {
  const h = harness(); await connectMedia(h);
  h.sockets[0].close(); await settle();
  h.client.deactivate(); await settle();
  assert.equal(h.media[0].closes, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.client.getState().call, null);
});

test('logout closes the old socket and media without sending HTTP using a new account', async () => {
  const h = harness(); await h.login(); await h.client.startCall(1, 'audio', { username: 'bob' });
  const before = h.requests.length; h.setIdentity('carol'); h.client.deactivate();
  assert.equal(h.media[0].closes, 1);
  assert.equal(h.requests.length, before);
  assert.equal(h.sockets[0].readyState, 3);
  assert(h.sockets[0].sent.some((message) => message.type === 'call.end'));
});

test('a create response from an old session never uses the socket or credentials of the next account', async () => {
  const createGate = deferred(); let h;
  h = harness({ request: async (method, url) => url === '/calls/' ? createGate.promise : { call: null, iceServers: [] } });
  await h.login(); const pending = h.client.startCall(1, 'audio', { username: 'bob' }); await settle();
  h.setIdentity('carol'); h.client.deactivate(); await h.login();
  const before = h.requests.length;
  createGate.resolve({ call: h.outgoing() }); await pending;
  assert.equal(h.requests.length, before);
  assert(!h.sockets.at(-1).sent.some((message) => message.callId === 'call-1'));
  assert.equal(h.client.getState().call, null);
  assert.equal(h.media[0].closes, 1);
  h.client.deactivate();
});

test('repeated foreground notifications do not leak signaling sockets', async () => {
  const h = harness(); await h.login();
  h.client.setForeground(true); h.client.setForeground(true); await settle();
  assert.equal(h.sockets.length, 1);
  h.client.setForeground(false); h.client.setForeground(true); await settle();
  assert.equal(h.sockets.length, 2);
  h.client.deactivate();
});

test('an expiry snapshot with no active server call releases the ringing client', async () => {
  const h = harness(); await h.login(); await h.client.startCall(1, 'audio', { username: 'bob' });
  h.setServerCall(null);
  h.sockets[0].deliver({ type: 'call.current', call: null });
  await settle();
  assert.equal(h.client.getState().call.status, 'ended');
  assert.equal(h.media[0].closes, 1);
  h.client.deactivate();
});

test('an older initial GET cannot end a new invitation when its empty response arrives late', async () => {
  const initial = deferred(); let reads = 0; let h;
  h = harness({ request: async (method, url) => {
    if (method === 'GET' && reads++ === 0) return initial.promise;
    if (method === 'GET') return { call: null, iceServers: [] };
    return { call: h.outgoing() };
  } });
  await h.login();
  await h.client.startCall(1, 'audio', { username: 'bob' });
  initial.resolve({ call: null, iceServers: [] }); await settle();
  assert.equal(h.client.getState().call.status, 'ringing');
  assert.equal(h.media[0].closes, 0);
  h.client.deactivate();
});

test('an unversioned empty socket snapshot is checked against the current server call', async () => {
  const h = harness(); await h.login(); await h.client.startCall(1, 'audio', { username: 'bob' });
  h.sockets[0].deliver({ type: 'call.current', call: null }); await settle();
  assert.equal(h.client.getState().call.status, 'ringing');
  assert.equal(h.media[0].closes, 0);
  h.client.deactivate();
});

test('mute and camera controls use the owned media session and end closes it once', async () => {
  const h = harness(); await h.login(); await h.client.startCall(1, 'video', { username: 'bob' });
  h.client.toggleMute(); h.client.toggleMute(); await h.client.switchCamera();
  assert.deepEqual(h.media[0].mutes, [false, true]);
  assert.equal(h.client.getState().call.frontCamera, false);
  await h.client.endCall(); h.client.deactivate();
  assert.equal(h.media[0].closes, 1);
});

test('a server end event supplies the final duration after local hangup even when the HTTP end request fails', async () => {
  let h;
  h = harness({ request: async (method, url, data) => {
    if (method === 'GET') return { call: null, iceServers: [] };
    if (url === '/calls/') return { call: h.outgoing() };
    if (data?.action === 'end') throw new Error('HTTP connection lost after socket hangup');
    return { call: null };
  } });
  await connectMedia(h);
  const activeAt = '2026-10-09T16:00:00.000Z';
  const active = h.outgoing({ status: 'active', version: 3, acceptedDeviceId: 'bob-device', activeAt, durationSeconds: 0 });
  h.sockets[0].deliver({ type: 'call.state', call: active });
  await h.client.endCall();
  assert.equal(h.client.getState().call.status, 'ended');
  assert.equal(h.media[0].closes, 1);
  assert(h.requests.some((request) => request.data?.action === 'end'));

  const endedAt = '2026-10-09T16:00:17.000Z';
  h.sockets[0].deliver({ type: 'call.state', call: { ...active, status: 'ended', version: 4,
    reason: 'ended', endedAt, durationSeconds: 17 } });
  const ended = h.client.getState().call;
  assert.equal(ended.activeAt, activeAt);
  assert.equal(ended.endedAt, endedAt);
  assert.equal(ended.durationSeconds, 17);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.reason, 'Llamada finalizada');
  assert.equal(ended.localStream, null);
  assert.equal(ended.remoteStream, null);
  assert.equal(h.captures.length, 1);
  assert.equal(h.media[0].closes, 1);
  h.client.deactivate();
});

test('a late end receipt cannot alter a later call or a call belonging to the next account', async () => {
  let h; let created = 0; let account = 'alice';
  h = harness({ request: async (method, url, data) => {
    if (method === 'GET') return { call: null, iceServers: [] };
    if (url === '/calls/') return { call: h.outgoing({ id: `call-${++created}`, caller: { username: account } }) };
    if (data?.action === 'end' || data?.action === 'cancel') throw new Error('End receipt will arrive over the socket');
    return { call: null };
  } });
  await connectMedia(h);
  await h.client.endCall();
  const lateReceipt = h.outgoing({ status: 'ended', version: 4, acceptedDeviceId: 'bob-device',
    activeAt: '2026-10-09T16:00:00.000Z', endedAt: '2026-10-09T16:00:17.000Z', durationSeconds: 17 });
  assert.equal(await h.client.startCall(1, 'audio', { username: 'bob' }), true);
  const nextCall = h.client.getState().call;
  h.sockets[0].deliver({ type: 'call.state', call: lateReceipt });
  assert.equal(h.client.getState().call, nextCall);
  assert.equal(nextCall.id, 'call-2');
  assert.equal(nextCall.durationSeconds, undefined);
  assert.equal(h.media[1].closes, 0);

  const oldSocketCallback = h.sockets[0].onmessage;
  h.client.deactivate(); h.setIdentity('carol'); account = 'carol';
  await h.login();
  assert.equal(await h.client.startCall(1, 'audio', { username: 'bob' }), true);
  const otherAccountCall = h.client.getState().call;
  oldSocketCallback({ data: JSON.stringify({ type: 'call.state', call: lateReceipt }) });
  h.sockets[1].deliver({ type: 'call.state', call: lateReceipt });
  assert.equal(h.client.getState().call, otherAccountCall);
  assert.equal(otherAccountCall.id, 'call-3');
  assert.equal(otherAccountCall.caller.username, 'carol');
  assert.equal(otherAccountCall.durationSeconds, undefined);
  assert.equal(h.media[2].closes, 0);
  h.client.deactivate();
});

test('native foreground readiness is required before inviting and receives only the owned RTC resources', async () => {
  const ready = deferred();
  const service = nativeService({ start: () => ready.promise });
  const h = harness({ makeNativeSession: service.start }); await h.login();
  const starting = h.client.startCall(1, 'video', { username: 'bob', name: 'Bob' }); await settle();
  assert.equal(service.configurations.length, 1);
  assert.equal(h.requests.filter((item) => item.url === '/calls/').length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(service.configurations[0].nativeResources)),
    { peerConnectionId: 10, streamId: 'own-local-stream', trackIds: ['own-audio'] });
  ready.resolve(); assert.equal(await starting, true);
  assert.equal(h.client.getState().call.backgroundReady, true);
  assert(service.leases[0].updates.some((update) => update.callId === 'call-1'));
  await h.client.endCall(); h.client.deactivate();
  assert.equal(service.leases[0].stops, 1);
  assert.equal(h.media[0].closes, 1);
});

test('cancelled or failed native startup never invites and releases a late native lease once', async () => {
  for (const mode of ['cancel', 'failure']) {
    const ready = deferred(); const service = nativeService({ start: () => ready.promise });
    const h = harness({ makeNativeSession: service.start }); await h.login();
    const starting = h.client.startCall(1, 'audio', { username: 'bob' }); await settle();
    if (mode === 'cancel') {
      await h.client.endCall();
      assert.equal(service.configurations[0].signal.aborted, true);
      ready.resolve();
    } else ready.reject(Object.assign(new Error('Android no inició el servicio.'), { code: 'CALL_SERVICE_FAILED' }));
    assert.equal(await starting, false, mode);
    assert.equal(h.requests.filter((item) => item.url === '/calls/').length, 0, mode);
    assert.equal(h.media[0].closes, 1, mode);
    if (mode === 'cancel') assert.equal(service.leases[0].stops, 1);
    h.client.deactivate();
  }
});

test('a native resource update failing during preparation cannot invite after the service has been released', async () => {
  for (const direction of ['outgoing', 'incoming']) {
    const service = nativeService({ update: () => Promise.reject(new Error('Native service stopped before invite')) });
    const h = harness({ makeNativeSession: service.start }); await h.login();
    if (direction === 'incoming') {
      const invitation = h.outgoing({ caller: { username: 'bob' }, callee: { username: 'alice' }, callerDeviceId: 'other-device' });
      h.setServerCall(invitation); h.sockets[0].deliver({ type: 'call.state', call: invitation });
    }
    assert.equal(await (direction === 'incoming' ? h.client.acceptCall() : h.client.startCall(1, 'audio', { username: 'bob' })), false);
    await settle();
    assert.equal(h.media[0].closes, 1, direction);
    assert.equal(service.leases[0].stops, 1, direction);
    assert.equal(h.requests.filter((item) => item.url === '/calls/' || item.data?.action === 'accept').length, 0, direction);
    h.client.deactivate();
  }
});

test('a native call keeps its signaling, media and heartbeat in background and notification hangup closes everything', async () => {
  const service = nativeService(); const h = harness({ makeNativeSession: service.start });
  await connectMedia(h);
  h.client.setForeground(false); await settle();
  assert.equal(h.sockets[0].readyState, 1);
  assert.equal(h.media[0].closes, 0);
  assert.equal(service.leases[0].stops, 0);
  const pulse = [...h.timers.values()].find((timer) => timer.delay === 20000);
  const before = h.sockets[0].sent.length; pulse.callback();
  assert(h.sockets[0].sent.slice(before).some((item) => item.type === 'call.heartbeat' && item.callId === 'call-1'));
  service.configurations[0].onHangup(); await settle();
  assert.equal(h.media[0].closes, 1);
  assert.equal(service.leases[0].stops, 1);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.client.getState().call.status, 'ended');
  assert(h.sockets[0].sent.some((item) => item.type === 'call.end' && item.callId === 'call-1'));
  assert(h.requests.some((item) => item.url === '/calls/call-1/action/' && item.data.action === 'end' && item.identity === 'alice'));
  h.client.deactivate(); assert.equal(service.leases[0].stops, 1);
});

test('an Android service stop ends the background call and stale service callbacks cannot affect another account', async () => {
  const service = nativeService(); const h = harness({ makeNativeSession: service.start });
  await connectMedia(h);
  h.client.setForeground(false);
  service.configurations[0].onServiceStopped(); await settle();
  assert.equal(h.media[0].closes, 1);
  assert.equal(service.leases[0].stops, 1);
  assert.match(h.client.getState().call.reason, /Android detuvo/);
  h.setIdentity('carol'); h.client.deactivate(); h.client.setForeground(true); await h.login();
  const socket = h.sockets.at(-1); const requests = h.requests.length;
  service.configurations[0].onHangup(); service.configurations[0].onServiceStopped();
  service.configurations[0].onAudioRoutes({ routes: [{ id: 'old', label: 'Old device' }], selectedRouteId: 'old' });
  h.captures[0].onLocalStream({ marker: 'old-local' }); h.captures[0].onRemoteStream({ marker: 'old-remote' });
  h.captures[0].onConnectionState('connected'); await settle();
  assert.equal(h.client.getState().call, null);
  assert.equal(h.client.getState().audioRoutes.length, 0);
  assert.equal(h.requests.length, requests);
  assert.equal(socket.sent.filter((item) => ['call.end', 'call.connected'].includes(item.type)).length, 0);
  h.client.deactivate();
});

test('JWT renewal authenticates the existing socket and server acknowledgment preserves the active native RTC lease', async () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const service = nativeService(); const h = harness({ now, makeNativeSession: service.start,
    getToken: (force) => force ? 'renewed-fixture-token' : 'initial-fixture-token' });
  await connectMedia(h);
  h.client.setForeground(false);
  h.sockets[0].deliver({ type: 'call.authenticated', accessExpiresAt: new Date(now + 120000).toISOString() });
  const renewal = [...h.timers.values()].find((timer) => timer.delay === 60000);
  await renewal.callback(); await settle();
  assert.equal(h.tokenRequests.filter((force) => force === true).length, 1);
  assert(h.sockets[0].sent.some((item) => item.type === 'call.auth' && item.token === 'renewed-fixture-token'));
  h.sockets[0].deliver({ type: 'call.authenticated', accessExpiresAt: new Date(now + 300000).toISOString() });
  assert([...h.timers.values()].some((timer) => timer.delay === 240000));
  assert.equal(h.sockets.length, 1);
  assert.equal(h.captures.length, 1);
  assert.equal(h.media[0].closes, 0);
  assert.equal(service.leases[0].stops, 0);
  assert.equal(h.client.getState().call.status, 'active');
  h.client.deactivate();
});

test('a transient token refresh failure near expiry closes media and reconnects signaling without capturing again', async () => {
  const now = Date.parse('2026-10-09T12:00:00Z'); let normalTokens = 0;
  const service = nativeService();
  const h = harness({ now, makeNativeSession: service.start, getToken: (force) => {
    if (force) throw new Error('Temporary refresh connection failure');
    return ++normalTokens === 1 ? 'initial-fixture-token' : 'recovered-fixture-token';
  } });
  await connectMedia(h);
  h.sockets[0].deliver({ type: 'call.authenticated', accessExpiresAt: new Date(now + 5000).toISOString() });
  const renewal = [...h.timers.values()].find((timer) => timer.delay === 1000);
  assert(renewal);
  await renewal.callback(); await settle();
  assert.equal(h.media[0].closes, 1);
  assert.equal(service.leases[0].stops, 1);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.client.getState().connected, false);
  assert.equal(h.client.getState().call.status, 'ended');
  assert.match(h.client.getState().call.reason, /renovar la sesión/);

  const reconnect = [...h.timers.values()].find((timer) => timer.delay === 3000);
  assert(reconnect);
  h.setServerCall(null);
  await reconnect.callback(); await settle();
  assert.equal(h.sockets.length, 2);
  assert.match(h.sockets[1].url, /token=recovered-fixture-token/);
  h.sockets[1].open(); await settle();
  assert.equal(h.client.getState().connected, true);
  assert.equal(h.captures.length, 1);
  assert.equal(service.leases.length, 1);
  const invitation = h.outgoing({ id: 'incoming-after-recovery', caller: { username: 'bob' },
    callee: { username: 'alice' }, callerDeviceId: 'other-device' });
  h.sockets[1].deliver({ type: 'call.state', call: invitation });
  assert.equal(h.client.getState().call.status, 'ringing');
  assert.equal(h.client.getState().call.direction, 'incoming');
  assert.equal(h.captures.length, 1);
  assert.equal(service.leases.length, 1);
  h.client.deactivate();
});

test('a token renewal finishing after logout cannot authenticate either the old or new account socket', async () => {
  for (const outcome of ['success', 'failure']) {
    const now = Date.parse('2026-10-09T12:00:00Z'); const token = deferred();
    const h = harness({ now, getToken: (force) => force ? token.promise : 'initial-fixture-token' });
    await connectMedia(h);
    h.sockets[0].deliver({ type: 'call.authenticated', accessExpiresAt: new Date(now + 120000).toISOString() });
    const renewing = [...h.timers.values()].find((timer) => timer.delay === 60000).callback();
    await settle(); h.setIdentity('carol'); h.client.deactivate(); await h.login();
    if (outcome === 'success') token.resolve('old-account-refreshed-token');
    else token.reject(new Error('Old account refresh failed after logout'));
    await renewing; await settle();
    assert.equal(h.sockets.length, 2, outcome);
    assert(h.sockets.every((socket) => !socket.sent.some((item) => item.type === 'call.auth')), outcome);
    assert(![...h.timers.values()].some((timer) => timer.delay === 3000), outcome);
    assert.equal(h.client.getState().call, null, outcome);
    assert.equal(h.media[0].closes, 1, outcome);
    h.client.deactivate();
  }
});

test('local and remote video state changes preserve audio and reject malformed media flags', async () => {
  const h = harness(); await connectMedia(h, 'video');
  const local = { marker: 'local-audio-video' }; const remote = { marker: 'remote-audio-video' };
  h.captures[0].onLocalStream(local); h.captures[0].onRemoteStream(remote);
  assert.equal(h.client.toggleVideo(), true);
  assert.deepEqual(h.media[0].videos, [false]);
  assert.equal(h.client.getState().call.videoEnabled, false);
  assert.equal(h.client.getState().call.muted, false);
  assert.equal(h.client.getState().call.localStream, local);
  const sendMedia = h.sockets[0].sent.filter((item) => item.type === 'call.signal' && item.signal.type === 'media');
  assert.equal(sendMedia.length, 1); assert.equal(sendMedia[0].signal.videoEnabled, false);
  h.sockets[0].deliver({ type: 'call.signal', callId: 'call-1', signal: { type: 'media', videoEnabled: 'false' } }); await settle();
  assert.equal(h.client.getState().call.remoteVideoEnabled, true);
  h.sockets[0].deliver({ type: 'call.signal', callId: 'call-1', signal: { type: 'media', videoEnabled: false } }); await settle();
  assert.equal(h.client.getState().call.remoteVideoEnabled, false);
  assert.equal(h.client.getState().call.remoteStream, remote);
  assert.equal(h.client.getState().call.muted, false);
  assert.deepEqual(h.media[0].mutes, []);
  assert.equal(h.media[0].closes, 0);
  assert.equal(h.client.toggleVideo(), true); assert.deepEqual(h.media[0].videos, [false, true]);
  h.client.deactivate();
});

test('audio route selection applies a returned native snapshot without an event and ignores results from a released lease', async () => {
  const pending = deferred();
  const routes = [{ id: 'earpiece', label: 'Auricular' }, { id: 'speaker', label: 'Altavoz' }];
  let count = 0;
  const service = nativeService({ selectRoute: () => ++count === 1 ? { routes, selectedRouteId: 'speaker' } : pending.promise });
  const h = harness({ makeNativeSession: service.start }); await connectMedia(h);
  assert.equal(await h.client.selectAudioRoute('speaker'), true);
  assert.equal(h.client.getState().audioRoute, 'speaker');
  assert.deepEqual(JSON.parse(JSON.stringify(h.client.getState().audioRoutes)), routes);
  const selecting = h.client.selectAudioRoute('earpiece'); await settle(); h.client.deactivate();
  pending.resolve({ routes, selectedRouteId: 'earpiece' });
  assert.equal(await selecting, false);
  assert.equal(h.client.getState().audioRoute, null);
  assert.equal(h.client.getState().audioRoutes.length, 0);
});
