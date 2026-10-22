import { Platform } from 'react-native';
import { getNativeRtcAvailability, getNativeRtcEngine, startLocalCapture } from './nativeRtc';

function callError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function friendlyError(error, code, message) {
  if (/^(CALL_|CAPTURE_|MICROPHONE_PERMISSION_DENIED$|CAMERA_PERMISSION_DENIED$)/.test(error?.code || '')) return error;
  if (/notallowed|permission|securityerror/i.test(`${error?.name} ${error?.message}`)) {
    return callError('CALL_PERMISSION_DENIED', 'Permite el acceso al micrófono y, para video, a la cámara para iniciar la llamada.');
  }
  return callError(code, message);
}

export function getCallAvailability() {
  if (Platform.OS === 'web') {
    if (globalThis.isSecureContext !== true) {
      return { available: false, reason: 'Abre la aplicación mediante HTTPS o localhost para usar las llamadas en este navegador.' };
    }
    if (typeof globalThis.navigator?.mediaDevices?.getUserMedia !== 'function' ||
        typeof globalThis.RTCPeerConnection !== 'function' || typeof globalThis.MediaStream !== 'function') {
      return { available: false, reason: 'Este navegador no permite llamadas de audio y video. Usa un navegador compatible o la app instalada.' };
    }
    return { available: true, reason: null };
  }
  const availability = getNativeRtcAvailability();
  if (!availability.available) return availability;
  const engine = getNativeRtcEngine();
  return typeof engine.RTCPeerConnection === 'function' && typeof engine.MediaStream === 'function'
    ? availability
    : { available: false, reason: 'Esta versión no incluye llamadas. Instala la versión actualizada de la app.' };
}

function getTracks(stream) {
  return typeof stream?.getTracks === 'function' ? stream.getTracks() : [];
}

function copyDescription(description) {
  if (!['offer', 'answer'].includes(description?.type) || typeof description?.sdp !== 'string' ||
      !description.sdp.trim() || description.sdp.length > 1048576) {
    throw callError('CALL_INVALID_DESCRIPTION', 'La señal de la llamada no es válida.');
  }
  return { type: description.type, sdp: description.sdp };
}

function copyCandidate(candidate) {
  if (candidate == null || candidate.candidate === '') return null;
  const value = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
  if (typeof value?.candidate !== 'string' || !value.candidate.trim() || value.candidate.length > 16384 ||
      (value.sdpMid != null && typeof value.sdpMid !== 'string') ||
      (value.sdpMLineIndex != null && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0)) ||
      (value.sdpMid == null && value.sdpMLineIndex == null)) {
    throw callError('CALL_INVALID_CANDIDATE', 'La conexión recibió una señal de red no válida.');
  }
  const result = { candidate: value.candidate, sdpMid: value.sdpMid ?? null, sdpMLineIndex: value.sdpMLineIndex ?? null };
  if (typeof value.usernameFragment === 'string') result.usernameFragment = value.usernameFragment;
  return result;
}

/** The Provider invokes this only after an outgoing invitation or incoming acceptance. */
export async function createRtcSession({
  kind, iceServers = [], signal, onLocalStream, onRemoteStream, onSignal, onConnectionState,
}) {
  if (!['audio', 'video'].includes(kind)) throw callError('CALL_INVALID_KIND', 'El tipo de llamada no es válido.');
  if (!Array.isArray(iceServers)) throw callError('CALL_INVALID_CONFIG', 'La configuración de conexión no es válida.');
  if (signal?.aborted) throw callError('CALL_CANCELLED', 'La llamada se cerró.');
  const availability = getCallAvailability();
  if (!availability.available) throw callError('CALL_UNAVAILABLE', availability.reason);
  const isNative = Platform.OS !== 'web';
  const engine = isNative ? getNativeRtcEngine() : globalThis;
  const captureController = new AbortController();
  let closed = false;
  let initialized = false;
  let localStream = null;
  let localLease = null;
  let peer = null;
  let videoSender = null;
  let cameraSwitch = null;
  let facingMode = 'user';
  let role = null;
  let offerPromise = null;
  let remoteDescriptionKey = null;
  let descriptionPromise = null;
  let remoteReady = false;
  let operations = Promise.resolve();
  let lastState = null;
  const queuedCandidates = [];
  const seenCandidates = new Set();
  const remoteTracks = new Map();
  const remoteContainers = new Set();
  const temporaryStreams = new Set();
  const stoppedTracks = new Set();

  function assertOpen() {
    if (closed || signal?.aborted) throw callError('CALL_CANCELLED', 'La llamada se cerró.');
  }

  function stopTrack(track) {
    if (!track || stoppedTracks.has(track)) return;
    stoppedTracks.add(track);
    try { track.stop(); } catch { /* Continue releasing the remaining tracks. */ }
  }

  function releaseContainer(stream) {
    try { stream.release?.(false); } catch { /* Peer close also releases its remote tracks. */ }
  }

  function stopWebStream(stream, keepTrack) {
    getTracks(stream).filter((track) => track !== keepTrack).forEach(stopTrack);
  }

  function notifyState(state, error) {
    if (closed && state !== 'closed') return;
    if (!error && state === lastState) return;
    lastState = state;
    try { onConnectionState?.(state, error); } catch { /* Consumer cleanup must not prevent native cleanup. */ }
  }

  function callbackFailed() {
    if (closed) return;
    notifyState('failed', callError('CALL_SIGNAL_FAILED', 'No se pudo mantener la señal de la llamada. Inténtalo de nuevo.'));
    close();
  }

  function publish(callback, value) {
    if (closed || typeof callback !== 'function') return;
    try {
      const result = callback(value);
      if (result && typeof result.catch === 'function') result.catch(callbackFailed);
      if (result === false && callback === onSignal) callbackFailed();
    } catch { callbackFailed(); }
  }

  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    captureController.abort();
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
    }
    if (localLease) {
      try { localLease.stop(); } catch { getTracks(localStream).forEach(stopTrack); }
    }
    else if (localStream) stopWebStream(localStream);
    temporaryStreams.forEach((stream) => stopWebStream(stream));
    temporaryStreams.clear();
    remoteTracks.forEach(stopTrack);
    remoteTracks.clear();
    remoteContainers.forEach(releaseContainer);
    remoteContainers.clear();
    queuedCandidates.length = 0;
    seenCandidates.clear();
    try { peer?.close(); } catch { /* Track cleanup still completes if the peer was already closed. */ }
    if (initialized) notifyState('closed');
  }

  function enqueue(operation) {
    const result = operations.then(() => { assertOpen(); return operation(); });
    operations = result.catch(() => {});
    return result;
  }

  async function applyCandidate(candidate) {
    assertOpen();
    try { await peer.addIceCandidate(candidate); } catch (error) {
      throw friendlyError(error, 'CALL_CANDIDATE_FAILED', 'No se pudo completar la conexión de la llamada.');
    }
    assertOpen();
  }

  signal?.addEventListener('abort', close, { once: true });
  try {
    if (isNative) {
      const lease = await startLocalCapture({ video: kind === 'video', signal: captureController.signal, exclusive: true });
      if (closed) { lease.stop(); assertOpen(); }
      localLease = lease;
      localStream = lease.stream;
    } else {
      const stream = await globalThis.navigator.mediaDevices.getUserMedia({
        audio: true, video: kind === 'video' ? { facingMode: 'user' } : false,
      });
      if (closed) { stopWebStream(stream); assertOpen(); }
      localStream = stream;
    }
    assertOpen();
    const tracks = getTracks(localStream);
    if (!tracks.some((track) => track.kind === 'audio' && track.readyState !== 'ended') ||
        (kind === 'video' && !tracks.some((track) => track.kind === 'video' && track.readyState !== 'ended'))) {
      throw callError('CALL_CAPTURE_FAILED', 'No se pudo preparar el micrófono o la cámara para esta llamada.');
    }
    peer = new engine.RTCPeerConnection({ iceServers });
    peer.onicecandidate = (event) => {
      if (closed || !event.candidate) return;
      try {
        const candidate = copyCandidate(event.candidate);
        if (candidate) publish(onSignal, { type: 'candidate', candidate });
      } catch { callbackFailed(); }
    };
    peer.ontrack = (event) => {
      if (closed) return;
      const tracks = [...(event.streams || []).flatMap(getTracks), ...(event.track ? [event.track] : [])];
      let changed = false;
      for (const track of tracks) {
        if (track.readyState === 'ended') continue;
        const id = track.id || track;
        if (!remoteTracks.has(id)) { remoteTracks.set(id, track); changed = true; }
      }
      if (!changed) return;
      try {
        // A fresh container also changes native streamURL when video arrives
        // after audio, so RTCView searches the newly available video track.
        const stream = new engine.MediaStream([...remoteTracks.values()]);
        remoteContainers.add(stream);
        publish(onRemoteStream, stream);
      } catch { callbackFailed(); }
    };
    const updateConnectionState = () => {
      if (closed) return;
      const iceState = peer.iceConnectionState;
      let state = peer.connectionState;
      // ICE connectivity alone does not confirm that DTLS is ready. Native
      // WebRTC and modern browsers expose the aggregate state, including 'new'.
      if (typeof state !== 'string' || !state) {
        state = { checking: 'connecting', connected: 'connected', completed: 'connected',
          disconnected: 'disconnected', failed: 'failed', closed: 'closed' }[iceState] || 'new';
      }
      notifyState(state);
    };
    peer.onconnectionstatechange = updateConnectionState;
    peer.oniceconnectionstatechange = updateConnectionState;
    for (const track of tracks) {
      const sender = peer.addTrack(track, localStream);
      if (track.kind === 'video') videoSender = sender;
    }
    initialized = true;
    publish(onLocalStream, localStream);
    assertOpen();
    notifyState('new');
  } catch (error) {
    close();
    throw friendlyError(error, 'CALL_CAPTURE_FAILED', 'No se pudo iniciar la llamada. Revisa el micrófono y la cámara e inténtalo de nuevo.');
  }

  return {
    offer() {
      try { assertOpen(); } catch (error) { return Promise.reject(error); }
      if (role === 'callee') return Promise.reject(callError('CALL_DESCRIPTION_CONFLICT', 'La llamada ya recibió una oferta.'));
      if (offerPromise) return offerPromise;
      role = 'caller';
      offerPromise = enqueue(async () => {
        try {
          const description = await peer.createOffer();
          assertOpen();
          await peer.setLocalDescription(description);
          assertOpen();
          return copyDescription(peer.localDescription || description);
        } catch (error) {
          throw friendlyError(error, 'CALL_OFFER_FAILED', 'No se pudo iniciar la conexión de la llamada.');
        }
      });
      return offerPromise;
    },
    receiveDescription(value) {
      let description;
      try { assertOpen(); description = copyDescription(value); } catch (error) { return Promise.reject(error); }
      const key = `${description.type}:${description.sdp}`;
      if (remoteDescriptionKey) {
        return key === remoteDescriptionKey ? descriptionPromise
          : Promise.reject(callError('CALL_DESCRIPTION_CONFLICT', 'La llamada recibió una señal incompatible.'));
      }
      if ((description.type === 'offer' && role === 'caller') || (description.type === 'answer' && role !== 'caller')) {
        return Promise.reject(callError('CALL_DESCRIPTION_CONFLICT', 'La llamada recibió una señal fuera de orden.'));
      }
      if (description.type === 'offer') role = 'callee';
      remoteDescriptionKey = key;
      descriptionPromise = enqueue(async () => {
        try {
          await peer.setRemoteDescription(description);
          assertOpen();
          remoteReady = true;
          while (queuedCandidates.length) await applyCandidate(queuedCandidates.shift());
          if (description.type === 'answer') return null;
          const answer = await peer.createAnswer();
          assertOpen();
          await peer.setLocalDescription(answer);
          assertOpen();
          return copyDescription(peer.localDescription || answer);
        } catch (error) {
          throw friendlyError(error, 'CALL_DESCRIPTION_FAILED', 'No se pudo completar la conexión de la llamada.');
        }
      });
      return descriptionPromise;
    },
    addCandidate(value) {
      let candidate;
      try { assertOpen(); candidate = copyCandidate(value); } catch (error) { return Promise.reject(error); }
      if (!candidate) return Promise.resolve(false);
      const key = JSON.stringify(candidate);
      if (seenCandidates.has(key)) return Promise.resolve(true);
      if (seenCandidates.size >= 256) return Promise.reject(callError('CALL_CANDIDATE_LIMIT', 'La conexión recibió demasiadas señales de red.'));
      seenCandidates.add(key);
      if (!remoteReady) { queuedCandidates.push(candidate); return Promise.resolve(true); }
      return enqueue(async () => { await applyCandidate(candidate); return true; });
    },
    setMicrophoneEnabled(enabled) {
      if (closed) return false;
      if (localLease) return localLease.setMicrophoneEnabled(enabled);
      const tracks = getTracks(localStream).filter((track) => track.kind === 'audio' && track.readyState !== 'ended');
      tracks.forEach((track) => { track.enabled = Boolean(enabled); });
      return tracks.length > 0;
    },
    setCameraEnabled(enabled) {
      if (closed || kind !== 'video') return false;
      const tracks = getTracks(localStream).filter((track) => track.kind === 'video' && track.readyState !== 'ended');
      tracks.forEach((track) => { track.enabled = Boolean(enabled); });
      return tracks.length > 0;
    },
    getNativeResourceIds() {
      if (!isNative || closed) return null;
      return { peerConnectionId: peer?._pcId, streamId: localStream?.toURL?.(),
        trackIds: getTracks(localStream).map((track) => track.id).filter((id) => typeof id === 'string') };
    },
    switchCamera() {
      if (closed || kind !== 'video') return Promise.resolve(false);
      if (cameraSwitch) return cameraSwitch;
      cameraSwitch = Promise.resolve().then(async () => {
        if (closed) return false;
        if (localLease) {
          try {
            const changed = await localLease.switchCamera();
            return !closed && changed;
          } catch (error) {
            if (closed) return false;
            throw friendlyError(error, 'CALL_CAMERA_SWITCH_FAILED', 'No se pudo cambiar de cámara. Puedes continuar con la cámara actual.');
          }
        }
        if (!videoSender || typeof videoSender.replaceTrack !== 'function') return false;
        let replacement;
        try {
          const nextMode = facingMode === 'user' ? 'environment' : 'user';
          replacement = await globalThis.navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: nextMode } } });
          if (closed) { stopWebStream(replacement); return false; }
          temporaryStreams.add(replacement);
          const nextTrack = getTracks(replacement).find((track) => track.kind === 'video' && track.readyState !== 'ended');
          if (!nextTrack) throw callError('CALL_CAMERA_SWITCH_FAILED', 'No se pudo abrir la otra cámara.');
          await videoSender.replaceTrack(nextTrack);
          if (closed) return false;
          getTracks(localStream).filter((track) => track.kind === 'video').forEach((track) => {
            localStream.removeTrack(track);
            stopTrack(track);
          });
          localStream.addTrack(nextTrack);
          stopWebStream(replacement, nextTrack);
          temporaryStreams.delete(replacement);
          facingMode = nextMode;
          publish(onLocalStream, localStream);
          return !closed;
        } catch (error) {
          if (replacement) { stopWebStream(replacement); temporaryStreams.delete(replacement); }
          if (closed) return false;
          throw friendlyError(error, 'CALL_CAMERA_SWITCH_FAILED', 'No se pudo cambiar de cámara. Puedes continuar con la cámara actual.');
        }
      }).finally(() => { cameraSwitch = null; });
      return cameraSwitch;
    },
    close,
  };
}
