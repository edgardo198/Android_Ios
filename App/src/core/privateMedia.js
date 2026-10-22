import api, { getApiBaseUrl, resolveMediaUrl } from './api';
import useGlobal from './global';

const PRIVATE_PATH = /^\/chat\/messages\/[1-9]\d*\/media\/(image|audio|video|document)\/$/;
const REFRESH_MARGIN_MS = 30000;
const tickets = new Map();
const requests = new Map();
const sessionListeners = new Set();
let generation = 0;
let account = readAccount();

function readAccount() {
  const state = useGlobal.getState();
  return state.authenticated && typeof state.user?.username === 'string' ? state.user.username : null;
}

useGlobal.subscribe(() => {
  const next = readAccount();
  if (next !== account) {
    account = next;
    generation += 1;
    tickets.clear();
    requests.clear();
    sessionListeners.forEach((listener) => listener());
  }
});

export function getMediaSessionGeneration() {
  return generation;
}

export function subscribeMediaSession(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export function captureMediaSession() {
  const currentAccount = account;
  const currentGeneration = generation;
  return {
    account: currentAccount,
    generation: currentGeneration,
    active: () => account === currentAccount && generation === currentGeneration && currentAccount !== null,
    assertActive() {
      if (!this.active()) {
        const error = new Error('La sesión cambió. Abre el archivo desde tu cuenta actual.');
        error.code = 'SESSION_CHANGED';
        throw error;
      }
    },
  };
}

export function privateMediaPath(source) {
  if (!source || /^(file:|content:|blob:|data:)/i.test(String(source))) return null;
  try {
    const base = new URL(resolveMediaUrl('/'));
    const url = new URL(resolveMediaUrl(source));
    return url.origin === base.origin && !url.username && !url.password && PRIVATE_PATH.test(url.pathname)
      ? url.pathname : null;
  } catch { return null; }
}

export function isPrivateMediaSource(source) {
  return privateMediaPath(source) !== null;
}

export function mediaCacheIdentity(source) {
  const path = privateMediaPath(source);
  return path ? `${account || ''}:${resolveMediaUrl(path)}` : resolveMediaUrl(source);
}

export async function getMediaSource(source, { forceRefresh = false } = {}) {
  const path = privateMediaPath(source);
  if (!path) return resolveMediaUrl(source);
  const session = captureMediaSession();
  session.assertActive();
  const baseURL = await getApiBaseUrl();
  session.assertActive();
  const stable = new URL(path, `${baseURL}/`);
  const key = `${session.account}:${stable.href}`;
  if (!forceRefresh && tickets.get(key)?.expiresAt > Date.now() + REFRESH_MARGIN_MS) return tickets.get(key).uri;
  if (requests.has(key)) return requests.get(key);
  const started = Date.now();
  const pending = (async () => {
    const response = await api.post(`${path}access/`);
    session.assertActive();
    const url = new URL(response?.data?.url, `${baseURL}/`);
    const ttl = Math.min(900, Number(response?.data?.expiresIn));
    const queryKeys = [...url.searchParams.keys()];
    if (url.origin !== stable.origin || url.pathname !== path || url.username || url.password || url.hash ||
        !url.searchParams.get('ticket') || queryKeys.length !== 1 || queryKeys[0] !== 'ticket' || !Number.isFinite(ttl) || ttl <= 0) {
      throw new Error('El servidor no devolvió un enlace de archivo válido.');
    }
    const expiresAt = started + ttl * 1000;
    if (expiresAt <= Date.now()) throw new Error('El enlace del archivo venció. Intenta nuevamente.');
    if (tickets.size >= 200) tickets.delete(tickets.keys().next().value);
    tickets.set(key, { uri: url.href, expiresAt });
    return url.href;
  })();
  requests.set(key, pending);
  try { return await pending; } finally { if (requests.get(key) === pending) requests.delete(key); }
}
