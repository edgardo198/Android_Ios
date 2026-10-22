const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/;
const EVENT_ID = DECIMAL_ID;
const RENEW_BEFORE = 60000;
const EXPIRY_CHECK_INTERVAL = 86400000;

export function noticeUserId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && DECIMAL_ID.test(value) ? value : null;
}

function authVersion(value) {
  const version = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

export function deviceEventsUrl(base) {
  const parsed = new URL(String(base));
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Dirección de recepción no válida.');
  }
  return `${parsed.toString().replace(/\/+$/, '')}/ws/device-events/`;
}

export function createNativeNoticeQueue() {
  const pending = [];
  let busy = false;
  const drain = () => {
    if (busy || !pending.length) return;
    busy = true;
    const task = pending.shift();
    let result;
    try { result = task.action(); } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(task.resolve, task.reject).finally(() => { busy = false; drain(); });
  };
  return (action) => new Promise((resolve, reject) => { pending.push({ action, resolve, reject }); drain(); });
}

export function createNoticeCoordinator({ store, native, registerDevice, revokeDevice, getWsUrl, randomUUID,
  getAppState = () => 'active', subscribeAppState = () => () => {}, subscribeNative = () => () => {},
  getForegroundConnection, canOpen = () => false, onOpen = () => false, onState = () => {},
  available = true, reason = null, runNative = createNativeNoticeQueue(), now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let state = { available, reason, enabled: true, loading: false, changing: false, starting: false,
    running: false, connected: false, permissionGranted: null, expiresAt: null, error: null, ready: false };
  let context = null, epoch = 0, disposed = false, started = false, operation = null, preferenceOperation = null;
  let choice = null, permissionAttempted = false, failed = false, preferenceDirty = false, expiryTimer = null, startupTimer = null;
  let configuredExpiry = null, foregroundKey = null, guestStopped = false, pendingOpen = null, opening = false;
  const opened = new Set(), cleanups = [];

  const publish = (update) => { if (!disposed) { state = { ...state, ...update }; onState(state); } };
  const current = (candidate) => !!candidate && !disposed && store.getState().authenticated &&
    store.getState().outboxIdentityVerified && store.getState().isAuthSessionCurrent(candidate.snapshot) &&
    noticeUserId(store.getState().user?.id) === candidate.userId &&
    (authVersion(store.getState().user?.authVersion) ?? 0) === candidate.authVersion;
  const capture = () => {
    const value = store.getState(), userId = noticeUserId(value.user?.id);
    const snapshot = value.captureAuthSession?.();
    if (!value.authenticated || !value.outboxIdentityVerified || !userId || !snapshot || !value.user?.username) return null;
    return { snapshot, userId, username: value.user.username, authVersion: authVersion(value.user.authVersion) ?? 0 };
  };
  const valid = (task) => !disposed && context === task.context && epoch === task.epoch && current(task.context);
  const foreground = () => getAppState() === 'active';
  const stop = () => runNative(() => native.stop()).catch(() => {});
  const clearTimers = () => { clearTimer(expiryTimer); clearTimer(startupTimer); expiryTimer = startupTimer = null; };
  const guarded = (task, action) => runNative(() => valid(task) ? action() : undefined);

  const updateForeground = () => {
    if (!available || !current(context)) return;
    const candidate = context, active = foreground();
    const connectionId = active ? noticeUserId(getForegroundConnection ? getForegroundConnection() : store.getState().messagesConnectionId) : null;
    const key = `${candidate.userId}:${active}:${connectionId}`;
    if (key === foregroundKey) return;
    foregroundKey = key;
    void runNative(() => current(candidate) ? native.setForeground(active, connectionId) : undefined).catch(() => { foregroundKey = null; });
  };

  const flushOpen = () => {
    updateForeground();
    if (opening || !pendingOpen || !foreground() || !current(context) || !canOpen()) return false;
    const event = pendingOpen;
    if (event.noticeUserId !== context.userId) { pendingOpen = null; return false; }
    const friend = (store.getState().friendList || []).find((item) => String(item.id) === event.connectionId && item.friend?.username);
    if (!friend) return false;
    if (opened.has(event.noticeEventId)) { pendingOpen = null; return false; }
    const candidate = context;
    if (!current(candidate)) return false;
    opening = true;
    try {
      if (onOpen({ ...event, connectionId: friend.id, friend: friend.friend }) === false) return false;
    } catch { return false; }
    finally { opening = false; }
    opened.add(event.noticeEventId);
    if (opened.size > 128) opened.delete(opened.values().next().value);
    if (pendingOpen === event) pendingOpen = null;
    return true;
  };
  const receiveOpen = (event) => {
    if (disposed || !noticeUserId(event?.noticeUserId) || typeof event?.noticeEventId !== 'string' || !EVENT_ID.test(event.noticeEventId) ||
        !noticeUserId(event.connectionId) || (event.callId != null && (typeof event.callId !== 'string' || !DEVICE_ID.test(event.callId)))) return false;
    pendingOpen = { noticeUserId: noticeUserId(event.noticeUserId), noticeEventId: event.noticeEventId,
      connectionId: String(event.connectionId), callId: event.callId || null };
    return flushOpen();
  };
  const scheduleExpiry = (expiresAt) => {
    clearTimer(expiryTimer);
    const remaining = Date.parse(expiresAt) - now();
    if (!Number.isFinite(remaining)) return;
    const candidate = context;
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      if (!current(candidate)) return;
      if (Date.parse(expiresAt) - now() > (foreground() ? RENEW_BEFORE : 0)) {
        scheduleExpiry(expiresAt); return;
      }
      configuredExpiry = null;
      if (foreground()) { failed = false; void ensure(); }
      else if (Date.parse(expiresAt) <= now()) publish({ running: false, connected: false, error: 'Abre la app para renovar la recepción.' });
      else scheduleExpiry(expiresAt);
    }, Math.min(EXPIRY_CHECK_INTERVAL, Math.max(1000, remaining - (foreground() ? RENEW_BEFORE : 0))));
  };
  const applyNativeState = (value) => {
    if (!current(context) || (value?.userId != null && noticeUserId(value.userId) !== context.userId)) return;
    const own = noticeUserId(value?.userId) === context.userId && authVersion(value?.authVersion) === context.authVersion;
    const running = own && value.running === true;
    publish({ running, connected: running && value.connected === true,
      ...(typeof value?.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}),
      ...(running ? { starting: false, error: null } : {}) });
    if (running) { clearTimer(startupTimer); startupTimer = null; }
    else if (!state.starting && !operation && !preferenceOperation && choice && !failed && foreground()) {
      configuredExpiry = null; void ensure();
    }
  };
  const waitForStart = (task, expiresAt) => {
    configuredExpiry = expiresAt;
    publish({ expiresAt, starting: !state.running });
    scheduleExpiry(expiresAt); updateForeground();
    clearTimer(startupTimer);
    startupTimer = setTimer(async () => {
      startupTimer = null;
      if (!valid(task)) return;
      try {
        const value = await guarded(task, () => native.getState());
        if (!valid(task)) return;
        if (value?.running && noticeUserId(value.userId) === task.context.userId && authVersion(value.authVersion) === task.context.authVersion) {
          applyNativeState(value);
        } else { failed = true; publish({ starting: false, error: 'No se pudo iniciar la recepción. Intenta nuevamente.' }); }
      } catch { if (valid(task)) { failed = true; publish({ starting: false, error: 'No se pudo comprobar la recepción. Intenta nuevamente.' }); } }
    }, 5000);
  };

  async function ensure() {
    if (!available || !current(context) || preferenceOperation || failed) return false;
    if (operation && valid(operation)) return operation.promise;
    if (choice === false) return false;
    if (configuredExpiry && Date.parse(configuredExpiry) - now() > RENEW_BEFORE && (state.running || state.starting)) return true;
    const task = { context, epoch, controller: new AbortController() };
    operation = task;
    publish({ loading: true, error: null });
    task.promise = (async () => {
      let registration = null;
      try {
        if (choice == null) {
          const preference = await guarded(task, () => native.getPreference(task.context.username));
          if (!valid(task)) return false;
          choice = preference !== false;
          publish({ enabled: choice });
        }
        if (!choice) { await guarded(task, () => native.stop()); return false; }
        let permission = await guarded(task, () => native.getPermission());
        if (!valid(task)) return false;
        if (!permission && foreground() && !permissionAttempted) {
          permissionAttempted = true;
          permission = await guarded(task, () => native.requestPermission());
          if (!valid(task)) return false;
        }
        publish({ permissionGranted: permission === true });
        if (!permission) {
          if (foreground()) failed = true;
          await guarded(task, () => native.stop());
          publish({ running: false, connected: false, error: 'Permite las notificaciones de Android y vuelve a intentar.' });
          return false;
        }
        const saved = await guarded(task, () => native.getRegistration());
        const nativeState = await guarded(task, () => native.getState());
        if (!valid(task)) return false;
        const deviceId = typeof saved?.deviceId === 'string' && DEVICE_ID.test(saved.deviceId) ? saved.deviceId.toLowerCase() : randomUUID();
        const sameIdentity = noticeUserId(saved?.userId) === task.context.userId && authVersion(saved?.authVersion) === task.context.authVersion;
        const reusable = sameIdentity && Date.parse(saved?.expiresAt) - now() > RENEW_BEFORE && nativeState?.enabled === true &&
          noticeUserId(nativeState.userId) === task.context.userId && authVersion(nativeState.authVersion) === task.context.authVersion;
        if (reusable) {
          if (nativeState.running === true) {
            configuredExpiry = saved.expiresAt;
            applyNativeState(nativeState); scheduleExpiry(saved.expiresAt); updateForeground();
          } else {
            if (!foreground()) { publish({ running: false, connected: false, error: 'Abre la app para activar la recepción.' }); return false; }
            const resumed = await guarded(task, () => foreground() ? native.resume(task.context.userId, String(task.context.authVersion)) : false);
            if (!valid(task) || !resumed) return false;
            waitForStart(task, saved.expiresAt);
          }
          return true;
        }
        // Keep the valid registration and server cursor while rotating its
        // credential. An explicit stop revokes it and would lose offline notices.
        if (noticeUserId(saved?.userId) && !sameIdentity) await guarded(task, () => native.stop());
        if (!valid(task)) return false;
        if (!foreground()) { publish({ running: false, connected: false, error: 'Abre la app para activar la recepción.' }); return false; }
        const wsUrl = deviceEventsUrl(await getWsUrl());
        if (!valid(task) || !foreground()) return false;
        registration = await registerDevice({ deviceId, platform: 'android' }, task.controller.signal);
        if (registration?.deviceId !== deviceId || typeof registration?.deviceToken !== 'string' ||
            !registration.deviceToken.startsWith('ndv_') || registration.deviceToken.length > 256 ||
            !Number.isFinite(Date.parse(registration.expiresAt)) || Date.parse(registration.expiresAt) <= now()) {
          throw new Error('Invalid device registration');
        }
        if (!valid(task) || !foreground()) { await revokeDevice(registration).catch(() => {}); registration = null; return false; }
        const configured = await runNative(async () => {
          if (!valid(task) || !foreground()) return false;
          try {
            await native.configure({ enabled: true, wsUrl, token: registration.deviceToken,
              userId: task.context.userId, username: task.context.username, deviceId,
              authVersion: String(task.context.authVersion), expiresAt: registration.expiresAt });
          } catch (error) { await native.stop().catch(() => {}); throw error; }
          if (!valid(task)) { await native.stop(); return false; }
          return true;
        });
        if (!configured) { await revokeDevice(registration).catch(() => {}); registration = null; return false; }
        waitForStart(task, registration.expiresAt);
        registration = null;
        return true;
      } catch {
        if (registration) await revokeDevice(registration).catch(() => {});
        if (valid(task)) {
          failed = true;
          publish({ starting: false, running: false, connected: false, error: 'No se pudo activar la recepción. Revisa la conexión e intenta nuevamente.' });
        }
        return false;
      } finally {
        registration = null;
        if (operation === task) { operation = null; publish({ loading: false }); }
      }
    })();
    return task.promise;
  }

  const sync = () => {
    if (disposed || !available) return;
    if (context && !current(context)) {
      epoch++; operation?.controller.abort(); operation = null; preferenceOperation = null;
      clearTimers(); configuredExpiry = foregroundKey = null; choice = null; failed = permissionAttempted = preferenceDirty = false;
      pendingOpen = null; opened.clear(); context = null;
      void stop();
      publish({ ready: false, loading: false, changing: false, starting: false, running: false, connected: false, error: null, expiresAt: null });
    }
    const next = capture();
    if (!context && next) {
      context = next; guestStopped = false; publish({ ready: true, enabled: true });
    }
    if (!context) {
      const value = store.getState();
      if (value.initialized && !value.authenticated && !guestStopped) { guestStopped = true; pendingOpen = null; void stop(); }
      return;
    }
    updateForeground(); flushOpen();
    if (!failed && !preferenceOperation) void ensure();
  };

  const setEnabled = async (enabled) => {
    if (!available || typeof enabled !== 'boolean' || !current(context)) throw new Error('Abre tu sesión para cambiar esta opción.');
    if (preferenceOperation) return false;
    const candidate = context, change = {};
    preferenceOperation = change;
    epoch++; operation?.controller.abort(); operation = null;
    clearTimers(); configuredExpiry = null;
    choice = enabled; failed = false;
    publish({ enabled, changing: true, loading: false, error: null,
      ...(!enabled ? { starting: false, running: false, connected: false, expiresAt: null } : {}) });
    if (!enabled) void stop();
    try {
      const saved = await runNative(() => current(candidate) ? native.setPreference(candidate.username, enabled) : undefined);
      if (!current(candidate)) return false;
      if (saved === false) throw new Error('Preference could not be saved');
      permissionAttempted = false; preferenceDirty = false;
    } catch {
      if (current(candidate)) { failed = true; preferenceDirty = true; publish({ error: 'No se pudo guardar tu elección. Intenta nuevamente.' }); }
      return false;
    } finally {
      if (preferenceOperation === change) { preferenceOperation = null; publish({ changing: false }); }
    }
    return enabled ? ensure() : true;
  };

  return {
    getState: () => state,
    setEnabled,
    retry() {
      if (!current(context)) return Promise.resolve(false);
      if (preferenceDirty) return setEnabled(choice);
      failed = false; permissionAttempted = false; configuredExpiry = null; return ensure();
    },
    flushOpen, receiveOpen, handleNativeState: applyNativeState,
    start() {
      if (started || disposed) return;
      started = true;
      if (!available) { publish({ enabled: false }); return; }
      cleanups.push(store.subscribe(sync), subscribeAppState(() => {
        foregroundKey = null; updateForeground();
        if (foreground()) { if (!failed) void ensure(); flushOpen(); }
      }), subscribeNative(applyNativeState, receiveOpen));
      sync();
      void runNative(() => native.getPendingOpen()).then((event) => { if (event) receiveOpen(event); }).catch(() => {});
    },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; operation?.controller.abort(); operation = null;
      clearTimers(); cleanups.forEach((cleanup) => cleanup?.()); pendingOpen = null;
      // A valid native receiver continues after the UI closes; pending configurations are invalidated above.
      if (available) void runNative(() => native.setForeground(false, null)).catch(() => {});
    },
  };
}
