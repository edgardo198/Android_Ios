import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';

let nativeRtc = null;
let pendingOperation = null;
let activeOperation = null;

function captureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unavailableReason() {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return 'Esta prueba está disponible en la app instalada en Android o iOS.';
  }
  // StoreClient can also describe a development client. Detect Expo Go itself
  // before importing WebRTC, and never import an absent native module.
  if (isRunningInExpoGo() ||
      (Constants.executionEnvironment === 'storeClient' && !NativeModules.WebRTCModule)) {
    return 'Expo Go no incluye esta función. Abre la app instalada para probar micrófono y cámara.';
  }
  if (!NativeModules.WebRTCModule) {
    return 'Esta versión no incluye la prueba de llamadas. Instala la versión actualizada de la app.';
  }
  return null;
}

function loadNativeRtc() {
  const reason = unavailableReason();
  if (reason) throw captureError('CAPTURE_UNAVAILABLE', reason);
  if (!nativeRtc) {
    try {
      const rtc = require('react-native-webrtc');
      if (typeof rtc.mediaDevices?.getUserMedia !== 'function' || !rtc.RTCView) {
        throw new Error('Incomplete WebRTC module');
      }
      nativeRtc = rtc;
    } catch {
      throw captureError('CAPTURE_UNAVAILABLE',
        'No se pudo abrir la prueba de llamadas. Instala la versión actualizada de la app.');
    }
  }
  return nativeRtc;
}

export function getNativeRtcAvailability() {
  try {
    loadNativeRtc();
    return { available: true, reason: null };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

export function getNativeRtcView() {
  try {
    return loadNativeRtc().RTCView;
  } catch {
    return null;
  }
}

/** Guarded engine access for real calls; it never requests capture by itself. */
export function getNativeRtcEngine() {
  return loadNativeRtc();
}

function cancelledError(operation) {
  const error = captureError('CAPTURE_CANCELLED', 'La prueba local se canceló.');
  if (operation?.stage) error.stage = operation.stage;
  return error;
}

function assertCurrent(operation) {
  if (operation.cancelled) throw cancelledError(operation);
}

function tracksOf(stream) {
  return typeof stream?.getTracks === 'function' ? stream.getTracks() : [];
}

function stopStream(stream) {
  const tracks = tracksOf(stream);
  for (const track of tracks) {
    try { track.stop(); } catch { /* Continue releasing the other tracks. */ }
  }
  // Native track.stop() only disables the track. release() also tears down the
  // native capturers and removes their listeners; MediaStream releases tracks.
  if (typeof stream?.release === 'function') {
    try { stream.release(); return; } catch { /* Try releasing tracks individually. */ }
  }
  for (const track of tracks) {
    try { track.release?.(); } catch { /* Continue cleanup. */ }
  }
}

function removeAbortListeners(operation) {
  operation.abortCleanups.splice(0).forEach((cleanup) => cleanup());
}

function cancelOperation(operation) {
  operation.cancelled = true;
  operation.lease?.stop();
}

function bindAbortSignal(operation, signal) {
  if (!signal) return;
  if (signal.aborted) {
    cancelOperation(operation);
    return;
  }
  const onAbort = () => cancelOperation(operation);
  signal.addEventListener('abort', onAbort, { once: true });
  operation.abortCleanups.push(() => signal.removeEventListener('abort', onAbort));
}

async function requestCapturePermissions(operation) {
  if (Platform.OS !== 'android') return;
  const required = [{ permission: PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, kind: 'microphone' }];
  if (operation.video) {
    required.push({ permission: PermissionsAndroid.PERMISSIONS.CAMERA, kind: 'camera' });
  }
  const missing = [];
  for (const entry of required) {
    assertCurrent(operation);
    const granted = await PermissionsAndroid.check(entry.permission);
    assertCurrent(operation);
    if (!granted) missing.push(entry);
  }
  if (!missing.length) return;
  // Ask for only missing permissions together. Some Android permission dialogs
  // pause the Activity; UI cancellation must still prevent any later capture.
  const results = await PermissionsAndroid.requestMultiple(missing.map((entry) => entry.permission));
  assertCurrent(operation);
  for (const { permission, kind } of missing) {
    if (results[permission] !== PermissionsAndroid.RESULTS.GRANTED) {
      throw captureError(kind === 'microphone' ? 'MICROPHONE_PERMISSION_DENIED' : 'CAMERA_PERMISSION_DENIED',
        kind === 'microphone'
          ? 'Permite el acceso al micrófono en los ajustes de la aplicación para iniciar la prueba.'
          : 'Permite el acceso a la cámara en los ajustes de la aplicación para iniciar la prueba.');
    }
  }
}

function friendlyError(error, video) {
  if (/^(CAPTURE_|MICROPHONE_PERMISSION_DENIED$|CAMERA_PERMISSION_DENIED$)/.test(error?.code || '')) return error;
  if (/notallowed|permission|securityerror/i.test(`${error?.name} ${error?.message}`)) {
    return captureError('CAPTURE_PERMISSION_DENIED', video
      ? 'Permite el acceso al micrófono y la cámara en los ajustes de la aplicación para iniciar la prueba.'
      : 'Permite el acceso al micrófono en los ajustes de la aplicación para iniciar la prueba.');
  }
  if (/notfound|notreadable|devicesnotfound|trackstarterror/i.test(`${error?.name} ${error?.message}`)) {
    return captureError('CAPTURE_DEVICE_UNAVAILABLE', video
      ? 'No se pudo abrir el micrófono o la cámara. Comprueba que estén disponibles y cierra otras aplicaciones que los usen.'
      : 'No se pudo abrir el micrófono. Comprueba que esté disponible y cierra otras aplicaciones que lo usen.');
  }
  return captureError('CAPTURE_FAILED', video
    ? 'No se pudo iniciar la prueba del micrófono y la cámara. Inténtalo de nuevo.'
    : 'No se pudo iniciar la prueba del micrófono. Inténtalo de nuevo.');
}

function createLease(operation) {
  const stream = operation.stream;
  let stopped = false;
  let cameraSwitch = null;
  let facingMode = 'user';
  const lease = {
    stream,
    stop() {
      if (stopped) return;
      stopped = true;
      operation.cancelled = true;
      removeAbortListeners(operation);
      if (activeOperation === operation) activeOperation = null;
      operation.stream = null;
      stopStream(stream);
    },
    setMicrophoneEnabled(enabled) {
      if (stopped) return false;
      const tracks = tracksOf(stream).filter((track) => track.kind === 'audio' && track.readyState !== 'ended');
      for (const track of tracks) track.enabled = Boolean(enabled);
      return tracks.length > 0;
    },
    switchCamera() {
      if (stopped || !operation.video) return Promise.resolve(false);
      if (cameraSwitch) return cameraSwitch;
      const track = tracksOf(stream).find((item) => item.kind === 'video' && item.readyState !== 'ended');
      if (typeof track?.applyConstraints !== 'function') return Promise.resolve(false);
      cameraSwitch = Promise.resolve().then(async () => {
        if (stopped) return false;
        const nextFacingMode = facingMode === 'user' ? 'environment' : 'user';
        try {
          await track.applyConstraints({ facingMode: nextFacingMode });
          if (stopped) return false;
          facingMode = nextFacingMode;
          return true;
        } catch {
          if (stopped) return false;
          throw captureError('CAMERA_SWITCH_FAILED', 'No se pudo cambiar de cámara. Puedes continuar con la cámara actual.');
        }
      }).finally(() => { cameraSwitch = null; });
      return cameraSwitch;
    },
  };
  return lease;
}

/** Capture is explicitly started by the UI. This module never opens a connection. */
export function startLocalCapture({ video = false, signal, exclusive = false } = {}) {
  if (signal?.aborted) return Promise.reject(cancelledError());
  const wantsVideo = Boolean(video);
  if (pendingOperation) {
    if (exclusive || pendingOperation.exclusive || pendingOperation.cancelled || pendingOperation.video !== wantsVideo) {
      return Promise.reject(captureError('CAPTURE_BUSY', 'Espera a que termine la prueba anterior antes de iniciar otra.'));
    }
    bindAbortSignal(pendingOperation, signal);
    return pendingOperation.promise;
  }
  if (activeOperation) {
    if (exclusive || activeOperation.exclusive || activeOperation.video !== wantsVideo) {
      return Promise.reject(captureError('CAPTURE_BUSY', 'Detén la prueba actual antes de cambiar de modo.'));
    }
    bindAbortSignal(activeOperation, signal);
    return Promise.resolve(activeOperation.lease);
  }
  let rtc;
  try { rtc = loadNativeRtc(); } catch (error) { return Promise.reject(error); }
  const operation = { video: wantsVideo, exclusive: Boolean(exclusive), stage: 'permissions', cancelled: false, abortCleanups: [], stream: null, lease: null, promise: null };
  pendingOperation = operation;
  bindAbortSignal(operation, signal);
  operation.promise = (async () => {
    try {
      await requestCapturePermissions(operation);
      assertCurrent(operation);
      operation.stage = 'capture';
      operation.stream = await rtc.mediaDevices.getUserMedia({
        audio: true,
        video: wantsVideo ? { facingMode: 'user', frameRate: 30 } : false,
      });
      assertCurrent(operation);
      const tracks = tracksOf(operation.stream);
      if (!tracks.some((track) => track.kind === 'audio' && track.readyState !== 'ended')) {
        throw captureError('MICROPHONE_PERMISSION_DENIED', 'No se recibió audio. Permite el acceso al micrófono y vuelve a iniciar la prueba.');
      }
      if (wantsVideo && !tracks.some((track) => track.kind === 'video' && track.readyState !== 'ended')) {
        throw captureError('CAMERA_PERMISSION_DENIED', 'No se recibió video. Permite el acceso a la cámara y vuelve a iniciar la prueba.');
      }
      operation.lease = createLease(operation);
      operation.stage = 'active';
      activeOperation = operation;
      return operation.lease;
    } catch (error) {
      if (operation.stream) {
        stopStream(operation.stream);
        operation.stream = null;
      }
      throw operation.cancelled ? cancelledError(operation) : friendlyError(error, wantsVideo);
    } finally {
      if (pendingOperation === operation) pendingOperation = null;
      if (!operation.lease) removeAbortListeners(operation);
    }
  })();
  return operation.promise;
}

/** Cancellation keeps a pending native capture locked until its late result is released. */
export function cancelLocalCapture() {
  if (pendingOperation) cancelOperation(pendingOperation);
  if (activeOperation) cancelOperation(activeOperation);
}
