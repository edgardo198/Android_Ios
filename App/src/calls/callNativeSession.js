import { AppRegistry, AppState, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

const TASK = 'chatlocal.callKeepAlive';
const REQUIRED_METHODS = ['start', 'confirmKeepAlive', 'heartbeat', 'update', 'stop', 'getAudioRoutes', 'selectAudioRoute'];
const native = Platform.OS === 'android' ? NativeModules.ChatLocalCallSession : null;
const supported = !!native && REQUIRED_METHODS.every((name) => typeof native[name] === 'function');
const operations = new Map();
let activeOperation = null;
let sequence = 0;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function routesSnapshot(value) {
  const routes = Array.isArray(value?.routes) ? value.routes.filter((route) => (
    typeof route?.id === 'string' && typeof route.label === 'string'
      && ['speaker', 'earpiece', 'wired', 'bluetooth'].includes(route.type)
  )).map(({ id, label, type }) => ({ id, label, type })) : [];
  return { routes, selectedRouteId: routes.some((route) => route.id === value?.selectedRouteId) ? value.selectedRouteId : null };
}

function nativeResources(value) {
  if (!Number.isInteger(value?.peerConnectionId) || value.peerConnectionId < 0
    || typeof value.streamId !== 'string' || !value.streamId.length || value.streamId.length > 200
    || !Array.isArray(value.trackIds) || value.trackIds.length < 1 || value.trackIds.length > 4
    || value.trackIds.some((id) => typeof id !== 'string' || !id.length || id.length > 200)) {
    throw failure('CALL_NATIVE_RESOURCES_INVALID', 'No se pudieron proteger los recursos de la llamada.');
  }
  return { peerConnectionId: value.peerConnectionId, streamId: value.streamId, trackIds: [...value.trackIds] };
}

function notify(callback, value) {
  if (typeof callback === 'function') callback(value);
}

function finishTask(operation) {
  if (operation.heartbeat != null) clearInterval(operation.heartbeat);
  operation.heartbeat = null;
  operation.finishTask?.();
  operation.finishTask = null;
}

function closeOperation(operation, stopNative = true) {
  if (operation.stopPromise) return operation.stopPromise;
  operation.closed = true;
  operation.signal?.removeEventListener('abort', operation.abort);
  operation.listeners.forEach((listener) => listener.remove());
  operation.listeners = [];
  finishTask(operation);
  operations.delete(operation.token);
  // Keep single-flight ownership until the native stop has completed. A late
  // callback from the previous call must never stop or modify a newer call.
  operation.stopPromise = Promise.resolve().then(() => (
    stopNative && operation.started ? native.stop(operation.token) : true
  )).finally(() => {
    if (activeOperation === operation) activeOperation = null;
  });
  return operation.stopPromise;
}

function requireOpen(operation) {
  if (operation.closed || operation.signal?.aborted || activeOperation !== operation) {
    throw failure('CALL_NATIVE_CANCELLED', 'La llamada se cerró.');
  }
}

async function requestPermission(name, operation, message) {
  if (await PermissionsAndroid.check(name)) { requireOpen(operation); return; }
  requireOpen(operation);
  if (AppState.currentState !== 'active') throw failure('CALL_NATIVE_NOT_VISIBLE', 'Abre la app para iniciar la llamada.');
  const result = await PermissionsAndroid.request(name);
  requireOpen(operation);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) throw failure('CALL_NATIVE_PERMISSION_DENIED', message);
}

if (supported) {
  AppRegistry.registerHeadlessTask(TASK, () => async ({ token } = {}) => {
    const operation = operations.get(token);
    if (!operation || operation.closed) {
      try { await native.stop(token || ''); } catch { /* The native watchdog closes an unreachable service. */ }
      return;
    }
    if (operation.heldTask) { await operation.heldTask; return; }
    const held = new Promise((resolve) => { operation.finishTask = resolve; });
    operation.heldTask = held;
    try {
      const confirmed = await native.confirmKeepAlive(token);
      if (!confirmed || operation.closed || operation.signal?.aborted) {
        await closeOperation(operation);
      } else {
        operation.heartbeat = setInterval(() => {
          if (!operation.closed) native.heartbeat(token);
        }, 10000);
      }
    } catch (error) {
      try { notify(operation.onServiceStopped, { reason: 'keep_alive_failed' }); }
      catch { /* Ending the task must not depend on a UI callback. */ }
      // AppRegistry does not finish a task rejected with an ordinary Error.
      // Always settle this task even when stopping the native module fails.
      await closeOperation(operation).catch(() => {});
    }
    // RN treats the task as active until this promise resolves. This keeps its
    // Android timers running when the UI is paused without starting captures.
    await held;
  });
}

export function getCallNativeAvailability() {
  if (supported) return { available: true, reason: null };
  return {
    available: false,
    reason: Platform.OS === 'android'
      ? 'Esta versión no puede mantener llamadas con la pantalla bloqueada. Instala la app actualizada.'
      : 'La llamada debe mantenerse abierta en esta plataforma.',
  };
}

export async function startCallNativeSession({ kind, callId, peerName, nativeResources: resources, signal,
  onHangup, onServiceStopped, onAudioRoutes } = {}) {
  if (!supported) throw failure('CALL_NATIVE_UNAVAILABLE', getCallNativeAvailability().reason);
  if (signal?.aborted) throw failure('CALL_NATIVE_CANCELLED', 'La llamada se cerró.');
  if (kind !== 'audio' && kind !== 'video') throw failure('CALL_NATIVE_KIND_INVALID', 'Tipo de llamada no válido.');
  if (activeOperation) throw failure('CALL_NATIVE_BUSY', 'Espera a que termine la llamada anterior.');
  const ownResources = nativeResources(resources);
  const operation = { token: `call:${Date.now()}:${++sequence}`, kind, signal, onHangup, onServiceStopped,
    onAudioRoutes, listeners: [], closed: false, started: false, routes: routesSnapshot(null) };
  activeOperation = operation;
  operations.set(operation.token, operation);
  operation.abort = () => { closeOperation(operation).catch(() => {}); };
  signal?.addEventListener('abort', operation.abort, { once: true });
  const emitter = new NativeEventEmitter(native);
  operation.listeners = [
    emitter.addListener('ChatLocalCallAudioRoutes', (event) => {
      if (event?.token !== operation.token || operation.closed) return;
      operation.routes = routesSnapshot(event);
      notify(onAudioRoutes, operation.routes);
    }),
    emitter.addListener('ChatLocalCallHangup', (event) => {
      if (event?.token !== operation.token || operation.closed) return;
      try { notify(onHangup); } finally { closeOperation(operation).catch(() => {}); }
    }),
    emitter.addListener('ChatLocalCallServiceStopped', (event) => {
      if (event?.token !== operation.token || operation.closed) return;
      try { notify(onServiceStopped, { reason: event.reason || 'service_stopped' }); }
      finally { closeOperation(operation, false).catch(() => {}); }
    }),
  ];
  try {
    if (Number(Platform.Version) >= 33) await requestPermission(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      operation, 'Permite las notificaciones para controlar la llamada con la pantalla bloqueada.');
    requireOpen(operation);
    if (AppState.currentState !== 'active') throw failure('CALL_NATIVE_NOT_VISIBLE', 'Abre la app para iniciar la llamada.');
    operation.started = true;
    operation.routes = routesSnapshot(await native.start({ token: operation.token, kind,
      callId: typeof callId === 'string' ? callId : null,
      peerName: typeof peerName === 'string' ? peerName.slice(0, 80) : 'Contacto', nativeResources: ownResources }));
    requireOpen(operation);
    notify(onAudioRoutes, operation.routes);
    return {
      async update(value = {}) {
        requireOpen(operation);
        const update = {};
        if (typeof value.callId === 'string') update.callId = value.callId;
        if (typeof value.peerName === 'string') update.peerName = value.peerName.slice(0, 80);
        if (typeof value.muted === 'boolean') update.muted = value.muted;
        if (typeof value.videoEnabled === 'boolean') update.videoEnabled = value.videoEnabled;
        if (value.nativeResources != null) update.nativeResources = nativeResources(value.nativeResources);
        const result = await native.update(operation.token, update);
        requireOpen(operation);
        return result;
      },
      async getAudioRoutes() {
        requireOpen(operation);
        const snapshot = routesSnapshot(await native.getAudioRoutes(operation.token));
        requireOpen(operation);
        operation.routes = snapshot;
        return snapshot;
      },
      async selectAudioRoute(id) {
        requireOpen(operation);
        const current = routesSnapshot(await native.getAudioRoutes(operation.token));
        requireOpen(operation);
        const route = current.routes.find((entry) => entry.id === id);
        if (!route) throw failure('CALL_AUDIO_ROUTE_UNAVAILABLE', 'La salida de audio ya no está disponible.');
        if (route.type === 'bluetooth' && Number(Platform.Version) >= 31) {
          await requestPermission(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT, operation,
            'Permite el acceso a Bluetooth para usar los audífonos.');
        }
        requireOpen(operation);
        const snapshot = routesSnapshot(await native.selectAudioRoute(operation.token, id));
        requireOpen(operation);
        operation.routes = snapshot;
        notify(onAudioRoutes, snapshot);
        return snapshot;
      },
      stop: () => closeOperation(operation),
    };
  } catch (error) {
    await closeOperation(operation).catch(() => {});
    throw error;
  }
}
