const TERMINAL = new Set(['ended']);

function failureMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (error?.code && /^(CAPTURE_|CAMERA_|MICROPHONE_|RTC_|CALL_)/.test(error.code) && error.message) return error.message;
  return fallback;
}

/** Owns one call, including an optional native foreground service. */
export function createCallClient({ request, getToken, getWsUrl, getIdentity, getAuthVersion = () => 0,
  onAuthInvalidated = () => {}, makeSocket, makeRtc, makeNativeSession, uuid, availability }) {
  const deviceId = uuid();
  const listeners = new Set();
  let state = { call: null, connected: false, error: null, availability,
    audioRoutes: [], audioRoute: null, audioRouteError: null, historyRevision: 0 };
  let username = null;
  let epoch = 0;
  let foreground = true;
  let socket = null;
  let reconnectTimer = null;
  let pulseTimer = null;
  let authTimer = null;
  let authRenewal = null;
  let accessExpiresAt = null;
  let operation = null;
  let rawCall = null;
  let callRevision = 0;
  const closedIds = new Set();

  const publish = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
  };
  const authorized = () => Boolean(username && (foreground || operation?.backgroundReady) && getIdentity() === username);
  const current = (op) => Boolean(op && operation === op && op.epoch === epoch && authorized() && !op.controller.signal.aborted);
  const send = (payload) => {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(payload)); return true; } catch { return false; }
  };
  const view = (call) => {
    const outgoing = call.caller?.username === username;
    return {
      ...call, direction: outgoing ? 'outgoing' : 'incoming', peer: outgoing ? call.callee : call.caller,
      status: call.status === 'active' && !operation?.mediaConnected ? 'connecting' : call.status,
      localStream: operation?.localStream || null, remoteStream: operation?.remoteStream || null,
      muted: operation?.muted || false, frontCamera: operation?.frontCamera !== false,
      videoEnabled: operation?.videoEnabled !== false, remoteVideoEnabled: operation?.remoteVideoEnabled !== false,
      backgroundReady: Boolean(operation?.backgroundReady),
      preparing: Boolean(operation?.preparing),
    };
  };
  const ownDevice = (call) => [call.caller?.username, call.callee?.username].includes(username) &&
    (call.caller?.username === username ? call.callerDeviceId === deviceId
      : !call.acceptedDeviceId || call.acceptedDeviceId === deviceId);

  function release() {
    const op = operation;
    operation = null;
    if (!op) return;
    op.controller.abort();
    clearTimeout(op.mediaTimer);
    clearTimeout(op.disconnectTimer);
    try { op.rtc?.close(); } catch { /* Continue ending the call. */ }
    try { Promise.resolve(op.nativeLease?.stop()).catch(() => {}); } catch { /* Continue ending the call. */ }
    publish({ audioRoutes: [], audioRoute: null, audioRouteError: null });
  }

  function terminate(call, action = 'end', generation = epoch) {
    if (generation !== epoch || !call?.id || TERMINAL.has(call.status) || !ownDevice(call)) return Promise.resolve();
    closedIds.add(call.id);
    if (closedIds.size > 100) closedIds.delete(closedIds.values().next().value);
    // The socket is still bound to the old account when logout has begun.
    send({ type: 'call.end', callId: call.id, deviceId });
    if (!authorized()) return Promise.resolve();
    return request('POST', `/calls/${call.id}/action/`, { action, deviceId }).then((result) => {
      if (generation === epoch && state.call?.id === call.id && state.call.status === 'ended' && result?.call?.status === 'ended') {
        publish({ call: { ...state.call, activeAt: result.call.activeAt, endedAt: result.call.endedAt,
          durationSeconds: result.call.durationSeconds } });
      }
      return result;
    }).catch(() => null);
  }

  function finish(message = null, { notify = true, action = 'end' } = {}) {
    callRevision += 1;
    const previous = rawCall || state.call;
    // Authorize termination while the native lease still owns the background
    // call; releasing it first removes that authorization.
    const pending = notify ? terminate(previous, action) : Promise.resolve();
    release();
    rawCall = null;
    if (previous?.id) closedIds.add(previous.id);
    publish({ call: previous ? { ...state.call, ...previous, status: 'ended', preparing: false,
      localStream: null, remoteStream: null, reason: message || 'Llamada finalizada' } : null, error: null });
    if (!foreground) { closeSocket(); publish({ connected: false }); }
    return pending;
  }

  function fail(op, error, fallback) {
    if (!current(op)) return;
    finish(failureMessage(error, fallback));
  }

  function sendSignal(op, signal) {
    if (!current(op) || !op.callId) return false;
    if (!send({ type: 'call.signal', callId: op.callId, deviceId, signal })) {
      fail(op, null, 'Se perdió la conexión. Vuelve a llamar.');
      return false;
    }
    return true;
  }

  function flushCandidates(op) {
    if (!current(op) || !op.descriptionSent) return;
    for (const candidate of op.candidates.splice(0)) {
      if (!sendSignal(op, candidate)) break;
    }
  }

  async function negotiate(op) {
    if (!current(op) || !op.rtc || !op.callId || !rawCall || rawCall.status === 'ringing' || op.offered ||
        rawCall.caller?.username !== username) return;
    op.offered = true;
    try {
      const description = await op.rtc.offer();
      if (!current(op)) return;
      if (sendSignal(op, description)) { op.descriptionSent = true; flushCandidates(op); }
    } catch (error) { fail(op, error, 'No se pudo conectar el audio o video. Vuelve a llamar.'); }
  }

  function receiveSignal(data) {
    const op = operation;
    if (!op || data.callId !== op.callId || !current(op)) return;
    if (op.signals.length >= 256) { fail(op, null, 'No se pudo conectar la llamada.'); return; }
    op.signals.push(data.signal);
    drainSignals(op);
  }

  function drainSignals(op) {
    if (!current(op) || !op.rtc || op.draining) return;
    op.draining = true;
    (async () => {
      while (current(op) && op.signals.length) {
        const signal = op.signals.shift();
        if (signal?.type === 'candidate') await op.rtc.addCandidate(signal.candidate);
        else if (signal?.type === 'offer' || signal?.type === 'answer') {
          const answer = await op.rtc.receiveDescription(signal);
          if (answer && current(op) && sendSignal(op, answer)) {
            op.descriptionSent = true;
            flushCandidates(op);
          }
        } else if (signal?.type === 'media' && op.kind === 'video' && typeof signal.videoEnabled === 'boolean') {
          op.remoteVideoEnabled = signal.videoEnabled;
          if (state.call) publish({ call: { ...state.call, remoteVideoEnabled: signal.videoEnabled } });
        }
      }
    })().catch((error) => fail(op, error, 'No se pudo negociar la llamada. Vuelve a llamar.'))
      .finally(() => { op.draining = false; });
  }

  function applyCall(call) {
    if (!authorized() || !call?.id || ![call.caller?.username, call.callee?.username].includes(username)) return;
    if (closedIds.has(call.id)) {
      if (TERMINAL.has(call.status) && state.call?.id === call.id && state.call.status === 'ended') {
        publish({ call: { ...state.call, activeAt: call.activeAt, endedAt: call.endedAt,
          durationSeconds: call.durationSeconds } });
      } else if (!TERMINAL.has(call.status)) terminate(call);
      return;
    }
    if (rawCall?.id === call.id && Number(call.version) < Number(rawCall.version)) return;
    if (!ownDevice(call)) {
      if (rawCall?.id === call.id) finish('La llamada se respondió en otro dispositivo.', { notify: false });
      return;
    }
    if (TERMINAL.has(call.status)) {
      if (rawCall?.id === call.id || operation?.callId === call.id) {
        rawCall = call;
        const reasons = { rejected: 'Llamada rechazada', cancelled: 'Llamada cancelada', missed: 'No hubo respuesta',
          timeout: 'No se pudo conectar la llamada', disconnected: 'Se perdió la conexión' };
        finish(reasons[call.reason] || 'Llamada finalizada', { notify: false });
      }
      return;
    }
    const caller = call.caller?.username === username;
    if (!operation && (caller || call.status !== 'ringing')) {
      // A restarted app has no live media session. Never create one automatically.
      terminate(call);
      return;
    }
    if (rawCall && rawCall.id !== call.id) return;
    rawCall = call;
    callRevision += 1;
    if (operation && !operation.callId) operation.callId = call.id;
    if (operation?.nativeLease) updateNative(operation);
    publish({ call: view(call), error: null });
    if (operation) { negotiate(operation); drainSignals(operation); }
  }

  async function refresh(generation) {
    const revision = callRevision;
    const result = await request('GET', '/calls/current/');
    if (generation !== epoch || !authorized()) return;
    if (revision !== callRevision) return result;
    if (result.call) applyCall(result.call);
    else if (rawCall && !operation?.creating) finish('Llamada finalizada', { notify: false });
    return result;
  }

  function newOperation(kind) {
    callRevision += 1;
    const op = { epoch, kind, controller: new AbortController(), callId: null, rtc: null, candidates: [], signals: [],
      muted: false, frontCamera: true, videoEnabled: kind === 'video', remoteVideoEnabled: true,
      backgroundReady: false, nativeLease: null,
      preparing: true, creating: false, offered: false, descriptionSent: false, mediaConnected: false };
    operation = op;
    // Covers capture dialogs and negotiation even if a request or socket stalls.
    op.mediaTimer = setTimeout(() => {
      if (current(op) && !op.mediaConnected) finish('La llamada tardó demasiado. Vuelve a intentarlo.');
    }, 65000);
    return op;
  }

  async function prepare(op) {
    const config = await refresh(op.epoch);
    if (!current(op)) return false;
    const rtc = await makeRtc({ kind: op.kind, iceServers: config?.iceServers || [], signal: op.controller.signal,
      onLocalStream(stream) {
        if (!current(op)) return;
        op.localStream = stream;
        if (state.call) publish({ call: { ...state.call, localStream: stream } });
      },
      onRemoteStream(stream) {
        if (!current(op)) return;
        op.remoteStream = stream;
        if (state.call) publish({ call: { ...state.call, remoteStream: stream } });
      },
      onSignal(signal) {
        if (!current(op)) return;
        if (op.candidates.length >= 256) { fail(op, null, 'No se pudo conectar la llamada.'); return; }
        op.candidates.push(signal);
        flushCandidates(op);
      },
      onConnectionState(connectionState) {
        if (!current(op)) return;
        if (connectionState === 'connected') {
          clearTimeout(op.disconnectTimer);
          clearTimeout(op.mediaTimer);
          op.mediaConnected = true;
          if (state.call) publish({ call: { ...state.call, status: 'active' } });
          send({ type: 'call.connected', callId: op.callId, deviceId });
        } else if (connectionState === 'failed' || connectionState === 'closed') {
          fail(op, null, 'Se perdió el audio o video. Vuelve a llamar.');
        } else if (connectionState === 'disconnected') {
          clearTimeout(op.disconnectTimer);
          op.disconnectTimer = setTimeout(() => fail(op, null, 'Se perdió el audio o video. Vuelve a llamar.'), 8000);
        }
      },
    });
    if (!current(op)) { rtc.close(); return false; }
    op.rtc = rtc;
    if (makeNativeSession) {
      const nativeLease = await makeNativeSession({ kind: op.kind, callId: op.callId,
        peerName: state.call?.peer?.name || state.call?.peer?.username || 'Contacto',
        nativeResources: rtc.getNativeResourceIds?.(), signal: op.controller.signal,
        onHangup() { if (current(op)) finish('Llamada finalizada'); },
        onServiceStopped() { if (current(op)) fail(op, null, 'Android detuvo el servicio de llamada. Vuelve a llamar.'); },
        onAudioRoutes(value) {
          if (current(op)) publish({ audioRoutes: Array.isArray(value?.routes) ? value.routes : [],
            audioRoute: value?.selectedRouteId || null, audioRouteError: null });
        },
      });
      if (!current(op)) { await nativeLease?.stop(); return false; }
      if (!nativeLease) throw new Error('El servicio de llamada no respondió.');
      op.nativeLease = nativeLease;
      op.backgroundReady = true;
      await updateNative(op);
      if (!current(op)) return false;
    }
    drainSignals(op);
    return true;
  }

  function updateNative(op) {
    if (!current(op) || !op.nativeLease) return Promise.resolve(false);
    return Promise.resolve().then(() => {
      if (!current(op)) return false;
      return op.nativeLease.update({ callId: op.callId,
      peerName: state.call?.peer?.name || state.call?.peer?.username || 'Contacto',
      muted: op.muted, videoEnabled: op.videoEnabled, nativeResources: op.rtc?.getNativeResourceIds?.(),
      });
    }).catch(() => { if (current(op)) fail(op, null, 'No se pudo mantener el servicio de llamada.'); return false; });
  }

  async function startCall(connectionId, kind, peer) {
    if (!authorized() || !state.connected || operation || (state.call && state.call.status !== 'ended')) return false;
    if (!availability.available) { publish({ error: availability.reason }); return false; }
    if (!['audio', 'video'].includes(kind) || !connectionId) return false;
    rawCall = null;
    const op = newOperation(kind);
    publish({ call: { id: null, kind, direction: 'outgoing', peer, status: 'preparing', preparing: true,
      localStream: null, remoteStream: null, muted: false, frontCamera: true }, error: null });
    try {
      if (!await prepare(op) || !current(op)) return false;
      op.creating = true;
      const response = await request('POST', '/calls/', { connectionId, kind, deviceId, clientId: uuid() });
      op.creating = false;
      if (!current(op)) { terminate(response.call, 'end', op.epoch); return false; }
      op.preparing = false;
      op.callId = response.call.id;
      applyCall(response.call);
      return true;
    } catch (error) { fail(op, error, 'No se pudo iniciar la llamada. Comprueba la conexión.'); return false; }
  }

  async function acceptCall() {
    if (!authorized() || !state.connected || operation || !rawCall || rawCall.status !== 'ringing' ||
        rawCall.callee?.username !== username) return false;
    if (!availability.available) { publish({ error: availability.reason }); return false; }
    const invitation = rawCall;
    const op = newOperation(invitation.kind);
    op.callId = invitation.id;
    publish({ call: { ...state.call, preparing: true }, error: null });
    try {
      if (!await prepare(op) || !current(op)) return false;
      const response = await request('POST', `/calls/${invitation.id}/action/`, { action: 'accept', deviceId });
      if (!current(op)) return false;
      op.preparing = false;
      applyCall(response.call);
      return true;
    } catch (error) { fail(op, error, 'No se pudo aceptar la llamada.'); return false; }
  }

  function closeSocket() {
    clearTimeout(reconnectTimer);
    clearInterval(pulseTimer);
    clearTimeout(authTimer);
    authTimer = null;
    authRenewal = null;
    accessExpiresAt = null;
    reconnectTimer = null;
    const previous = socket;
    socket = null;
    if (previous) {
      previous.onclose = null;
      previous.onmessage = null;
      previous.onopen = null;
      previous.onerror = null;
      try { previous.close(); } catch { /* Already closed. */ }
    }
  }

  async function connect(generation) {
    if (generation !== epoch || !authorized()) return;
    try {
      const [token, base] = await Promise.all([getToken(), getWsUrl()]);
      if (generation !== epoch || !authorized() || !token) return;
      const ws = makeSocket(`${base}/ws/calls/?token=${encodeURIComponent(token)}&deviceId=${encodeURIComponent(deviceId)}`);
      socket = ws;
      ws.onopen = () => {
        if (socket !== ws || generation !== epoch || !authorized()) { ws.close(); return; }
        publish({ connected: true });
        refresh(generation).catch(() => null);
        send({ type: 'call.ping' });
        clearInterval(pulseTimer);
        pulseTimer = setInterval(() => {
          if (socket !== ws || generation !== epoch || !authorized()) return;
          send({ type: 'call.ping' });
          if (rawCall && ['connecting', 'active'].includes(rawCall.status) && ownDevice(rawCall)) {
            send({ type: 'call.heartbeat', callId: rawCall.id, deviceId });
          }
        }, 20000);
      };
      ws.onmessage = (event) => {
        if (socket !== ws || generation !== epoch || !authorized()) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'auth.invalidated') {
          if (!Number.isSafeInteger(data.authVersion) || data.authVersion <= Number(getAuthVersion() || 0)) return;
          const identity = username;
          // The revoked session cannot authorize termination requests. Release
          // local captures immediately; the backend ends its owned calls.
          epoch += 1;
          callRevision += 1;
          release();
          rawCall = null;
          closeSocket();
          username = null;
          publish({ call: null, connected: false, error: null, audioRoutes: [], audioRoute: null,
            audioRouteError: null, historyRevision: 0 });
          try { Promise.resolve(onAuthInvalidated({ username: identity, authVersion: data.authVersion })).catch(() => {}); } catch {}
        }
        else if (data.type === 'call.state') applyCall(data.call);
        else if (data.type === 'call.current') {
          if (data.call) applyCall(data.call);
          // An unversioned socket snapshot may precede a newer invitation.
          else if (rawCall && !operation?.creating) refresh(generation).catch(() => null);
        }
        else if (data.type === 'call.signal') receiveSignal(data);
        else if (data.type === 'call.history.cleared') publish({ historyRevision: state.historyRevision + 1 });
        else if (data.type === 'call.authenticated') {
          const expiration = Date.parse(data.accessExpiresAt);
          if (Number.isFinite(expiration)) {
            accessExpiresAt = expiration;
            scheduleAuthRenewal(ws, generation);
          }
        }
        else if (data.type === 'call.error' && data.callId && data.callId === rawCall?.id) {
          finish(typeof data.message === 'string' ? data.message : 'No se pudo conectar la llamada.');
        }
      };
      ws.onerror = () => { /* onclose handles retry without exposing the JWT URL. */ };
      ws.onclose = () => {
        if (socket !== ws || generation !== epoch) return;
        clearInterval(pulseTimer);
        clearTimeout(authTimer);
        authTimer = null;
        authRenewal = null;
        accessExpiresAt = null;
        socket = null;
        publish({ connected: false });
        if (operation || rawCall) finish('Se perdió la conexión. Vuelve a llamar.');
        if (authorized()) reconnectTimer = setTimeout(() => connect(generation), 3000);
      };
    } catch {
      if (generation === epoch && authorized()) {
        publish({ connected: false });
        reconnectTimer = setTimeout(() => connect(generation), 3000);
      }
    }
  }

  function scheduleAuthRenewal(ws, generation, retryDelay) {
    clearTimeout(authTimer);
    if (!accessExpiresAt || socket !== ws || generation !== epoch || !authorized()) return;
    authTimer = setTimeout(() => renewAuthentication(ws, generation), retryDelay || Math.max(1000, accessExpiresAt - Date.now() - 60000));
  }

  async function renewAuthentication(ws, generation) {
    if (authRenewal || socket !== ws || generation !== epoch || !authorized()) return;
    const renewal = { ws, generation };
    authRenewal = renewal;
    try {
      const token = await getToken(true);
      if (socket !== ws || generation !== epoch || !authorized()) return;
      if (!token || !send({ type: 'call.auth', token, deviceId })) throw new Error('No se pudo renovar la sesión.');
      // Await server confirmation, retrying before the old authorization expires.
      scheduleAuthRenewal(ws, generation, 5000);
    } catch {
      if (socket === ws && generation === epoch && authorized()) {
        if (accessExpiresAt && accessExpiresAt - Date.now() > 7000) scheduleAuthRenewal(ws, generation, 5000);
        else {
          if (operation || rawCall) finish('No se pudo renovar la sesión. Inicia sesión nuevamente.');
          closeSocket(); publish({ connected: false });
          if (generation === epoch && authorized()) reconnectTimer = setTimeout(() => connect(generation), 3000);
        }
      }
    } finally { if (authRenewal === renewal) authRenewal = null; }
  }

  function deactivate() {
    terminate(rawCall);
    epoch += 1;
    release();
    rawCall = null;
    closeSocket();
    username = null;
    publish({ call: null, connected: false, error: null, audioRoutes: [], audioRoute: null, audioRouteError: null, historyRevision: 0 });
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    activate(identity) {
      deactivate();
      username = identity || null;
      if (authorized()) connect(epoch);
    },
    deactivate,
    setForeground(value) {
      const next = Boolean(value);
      if (foreground === next) return;
      foreground = next;
      const identity = username;
      if (!foreground && operation?.backgroundReady && authorized()) return;
      if (!foreground) deactivate();
      else if ((!socket || socket.readyState > 1) && (identity || getIdentity())) { username = identity || getIdentity(); connect(epoch); }
    },
    startCall, acceptCall,
    rejectCall: () => finish('Llamada rechazada', { action: 'reject' }),
    endCall: () => finish('Llamada finalizada', { action: rawCall?.status === 'ringing' ?
      rawCall.caller?.username === username ? 'cancel' : 'reject' : 'end' }),
    toggleMute() {
      const op = operation;
      if (!op?.rtc || !current(op)) return;
      try {
        if (op.rtc.setMicrophoneEnabled(op.muted) !== false) {
          op.muted = !op.muted;
          updateNative(op);
          publish({ call: { ...state.call, muted: op.muted } });
        }
      } catch { publish({ error: 'No se pudo cambiar el micrófono.' }); }
    },
    toggleVideo() {
      const op = operation;
      if (!op?.rtc || !current(op) || op.kind !== 'video' || state.call?.status !== 'active' || op.switching) return false;
      try {
        const next = !op.videoEnabled;
        if (op.rtc.setCameraEnabled(next) === false) return false;
        op.videoEnabled = next;
        publish({ call: { ...state.call, videoEnabled: next } });
        updateNative(op);
        return sendSignal(op, { type: 'media', videoEnabled: next });
      } catch { publish({ error: 'No se pudo cambiar el video.' }); return false; }
    },
    async selectAudioRoute(id) {
      const op = operation;
      if (!current(op) || !op.nativeLease || typeof id !== 'string') return false;
      try {
        const result = await op.nativeLease.selectAudioRoute(id);
        if (current(op) && result && Array.isArray(result.routes)) {
          publish({ audioRoutes: result.routes, audioRoute: result.selectedRouteId || null, audioRouteError: null });
        }
        return current(op) && result !== false;
      } catch {
        if (current(op)) publish({ audioRouteError: 'No se pudo cambiar la salida de audio. Comprueba el dispositivo conectado.' });
        return false;
      }
    },
    async switchCamera() {
      const op = operation;
      if (!op?.rtc || !current(op) || op.kind !== 'video' || !op.videoEnabled || op.switching) return;
      op.switching = true;
      try {
        if (await op.rtc.switchCamera() && current(op)) {
          op.frontCamera = !op.frontCamera;
          updateNative(op);
          publish({ call: { ...state.call, frontCamera: op.frontCamera, localStream: op.localStream } });
        }
      } catch { if (current(op)) publish({ error: 'No se pudo cambiar la cámara.' }); }
      finally { op.switching = false; }
    },
    dismiss() { if (!operation && (!rawCall || rawCall.status === 'ended')) publish({ call: null, error: null }); },
  };
}
