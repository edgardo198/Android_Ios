import { useEffect, useState } from 'react';
import { AppState, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { getAccessToken, getApiBaseUrl, getWsBaseUrl } from '../core/api';
import useGlobal from '../core/global';
import { createNativeNoticeQueue, createNoticeCoordinator } from './noticeCoordinator';

const required = ['configure', 'resume', 'getState', 'getRegistration', 'stop', 'setForeground', 'getPendingOpen',
  'getPreference', 'setPreference', 'getPermission', 'requestPermission'];
const native = Platform.OS === 'android' && !isRunningInExpoGo() &&
  (Constants.executionEnvironment !== 'storeClient' || NativeModules.ChatLocalNotices) ? NativeModules.ChatLocalNotices : null;
const available = !!native && required.every((name) => typeof native[name] === 'function');
const reason = available ? null : Platform.OS === 'android'
  ? 'Los avisos con la app cerrada están disponibles en la app de Android instalada y actualizada.'
  : 'En esta plataforma, mantén la app abierta para recibir los avisos.';
let publicState = { available, reason, enabled: available, loading: false, changing: false, starting: false,
  running: false, connected: false, permissionGranted: null, expiresAt: null, error: null, ready: false };
let coordinator = null;
const listeners = new Set();
const runNative = createNativeNoticeQueue();

export function getBackgroundNoticeState() { return publicState; }
export function subscribeBackgroundNotices(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useBackgroundNoticeState() {
  const [state, setState] = useState(publicState);
  useEffect(() => {
    const unsubscribe = subscribeBackgroundNotices(setState);
    setState(publicState);
    return unsubscribe;
  }, []);
  return state;
}
export function setBackgroundNoticesEnabled(enabled) {
  return coordinator ? coordinator.setEnabled(enabled) : Promise.resolve(false);
}
export function retryBackgroundNotices() { return coordinator ? coordinator.retry() : Promise.resolve(false); }
export function flushPendingNoticeOpen() { return coordinator ? coordinator.flushOpen() : false; }

async function registerDevice(body, signal) {
  const snapshot = useGlobal.getState().captureAuthSession();
  const current = () => useGlobal.getState().outboxIdentityVerified && useGlobal.getState().isAuthSessionCurrent(snapshot);
  if (!current() || signal.aborted) throw new Error('Registration cancelled');
  let token = await getAccessToken();
  const apiBase = await getApiBaseUrl();
  const base = new URL(apiBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid registration origin');
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!current() || signal.aborted || !token) throw new Error('Registration cancelled');
    // Keep an already-dispatched request readable after logout so its scoped
    // result can be revoked. The account JWT is captured, never sent to native.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    let response;
    try {
      response = await fetch(`${base.toString().replace(/\/+$/, '')}/notifications/devices/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: abort.signal,
      });
      if (response.status !== 401) {
        if (!response.ok) throw new Error('Device registration failed');
        return { ...await response.json(), apiBase };
      }
    } finally { clearTimeout(timer); }
    if (!current() || signal.aborted) throw new Error('Registration cancelled');
    if (attempt === 0) token = await getAccessToken(true);
    else {
      if (current()) void Promise.resolve(useGlobal.getState().logout()).catch(() => {});
      throw new Error('Device registration session expired');
    }
  }
  throw new Error('Device registration failed');
}

async function revokeDevice(registration) {
  // The captured, scoped credential cannot authenticate chat, calls or another
  // registration. Do not use Axios here: logout may have already changed its JWT.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(registration?.deviceId) ||
      typeof registration?.deviceToken !== 'string' || !/^ndv_[A-Za-z0-9_-]{16,200}$/.test(registration.deviceToken)) return;
  const base = new URL(registration.apiBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    await fetch(`${base.toString().replace(/\/+$/, '')}/notifications/devices/${registration.deviceId}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${registration.deviceToken}` }, signal: abort.signal,
    });
  } finally { clearTimeout(timer); }
}

export default function BackgroundNotices({ navigationRef } = {}) {
  useEffect(() => {
    const navigator = () => navigationRef?.current || navigationRef;
    const navigationReady = () => {
      const nav = navigator();
      if (!nav?.isReady?.() || !useGlobal.getState().initialized) return false;
      const root = nav.getRootState?.();
      return !root || root.routeNames?.includes('Messages') === true;
    };
    const instance = createNoticeCoordinator({
      store: useGlobal, native, available, reason, runNative, registerDevice, revokeDevice,
      getWsUrl: getWsBaseUrl, randomUUID,
      getAppState: () => AppState.currentState,
      subscribeAppState: (listener) => {
        const subscription = AppState.addEventListener('change', listener);
        return () => subscription.remove();
      },
      subscribeNative: (onState, onOpen) => {
        const emitter = new NativeEventEmitter(native);
        const subscriptions = [emitter.addListener('ChatLocalNoticeState', onState), emitter.addListener('ChatLocalNoticeOpen', onOpen)];
        return () => subscriptions.forEach((subscription) => subscription.remove());
      },
      getForegroundConnection: () => {
        const route = navigator()?.getCurrentRoute?.();
        return route?.name === 'Messages' ? route.params?.id : null;
      },
      canOpen: navigationReady,
      onOpen: ({ connectionId, friend }) => {
        if (!navigationReady()) return false;
        navigator().navigate('Messages', { id: connectionId, friend });
        return true;
      },
      onState: (state) => { publicState = state; listeners.forEach((listener) => listener(state)); },
    });
    coordinator = instance;
    instance.start();
    return () => { instance.dispose(); if (coordinator === instance) coordinator = null; };
  }, [navigationRef]);
  return null;
}
