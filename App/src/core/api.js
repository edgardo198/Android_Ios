import axios from 'axios';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import secure from './secure';

function getHostFromUri(value) {
  if (!value) {
    return null;
  }

  const cleaned = String(value).trim();
  if (!cleaned) {
    return null;
  }

  try {
    return new URL(/^[a-z]+:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`).hostname;
  } catch {
    return null;
  }
}

function getExpoHost() {
  const hostCandidates = [
    Constants.expoConfig?.hostUri,
    Constants.manifest2?.extra?.expoClient?.hostUri,
    Constants.manifest?.debuggerHost,
    Constants.experienceUrl,
    Constants.linkingUri,
  ];

  for (const candidate of hostCandidates) {
    const host = getHostFromUri(candidate);
    if (host) {
      return host;
    }
  }

  return null;
}

function normalizeBaseUrl(value) {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmedValue)
    ? trimmedValue
    : `http://${trimmedValue}`;

  return withProtocol.replace(/\/+$/, '');
}

function getWebBaseUrl() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return null;
  }

  if (process.env.EXPO_PUBLIC_API_SAME_ORIGIN === 'true') {
    return window.location.origin;
  }

  const { hostname, protocol } = window.location;
  if (!hostname) {
    return null;
  }

  const resolvedProtocol = protocol === 'https:' ? 'https' : 'http';
  return `${resolvedProtocol}://${hostname.includes(':') ? `[${hostname}]` : hostname}:8000`;
}

function isLoopbackHost(hostname) {
  return ['127.0.0.1', 'localhost', '10.0.2.2', '[::1]', '::1'].includes(hostname);
}

function rewriteLoopbackUrl(baseUrl, runtimeHost) {
  if (!baseUrl || !runtimeHost || runtimeHost === 'localhost') {
    return baseUrl;
  }

  try {
    const parsedUrl = new URL(baseUrl);
    if (!isLoopbackHost(parsedUrl.hostname)) {
      return baseUrl;
    }

    parsedUrl.hostname = runtimeHost;
    return parsedUrl.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl;
  }
}

function getDefaultPortForProtocol(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

function getPortFromBaseUrl(baseUrl) {
  if (!baseUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(baseUrl);
    return parsedUrl.port || getDefaultPortForProtocol(parsedUrl.protocol);
  } catch {
    return null;
  }
}

function getRuntimeHost() {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.hostname || null;
  }

  return expoHost;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function getHealthUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/health/`;
}

async function fetchWithTimeout(url, timeoutMs = 1500) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller?.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(url, {
        method: 'GET',
        signal: controller?.signal,
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

const fallbackHost = Platform.select({
  android: '10.0.2.2:8000',
  ios: '127.0.0.1:8000',
  web: '127.0.0.1:8000',
  default: '127.0.0.1:8000',
});

const expoHost = getExpoHost();
const inferredBaseUrl =
  getWebBaseUrl() || (expoHost ? `http://${expoHost}:8000` : null);

const explicitBaseUrl = normalizeBaseUrl(process.env.EXPO_PUBLIC_API_URL);
const configuredBaseUrl =
  explicitBaseUrl ||
  normalizeBaseUrl(inferredBaseUrl) ||
  normalizeBaseUrl(fallbackHost);

const initialApiBaseUrl =
  Platform.OS === 'web'
    ? configuredBaseUrl
    : rewriteLoopbackUrl(configuredBaseUrl, expoHost);

let resolvedApiBaseUrl = initialApiBaseUrl;
let apiBaseUrlVerified = false;
let apiBaseUrlPromise = null;

export const API_BASE_URL = initialApiBaseUrl;
export const ADDRESS = API_BASE_URL.replace(/^https?:\/\//i, '');
export const WS_BASE_URL = API_BASE_URL.replace(/^http/i, 'ws');

function getApiBaseUrlCandidates() {
  // An explicitly configured server is authoritative, including in production.
  // Never send credentials to a different server discovered on the local network.
  if (explicitBaseUrl || (typeof __DEV__ !== 'undefined' && !__DEV__)) {
    return [initialApiBaseUrl];
  }
  const runtimeHost = getRuntimeHost();
  const configuredPort = getPortFromBaseUrl(initialApiBaseUrl);
  const candidatePorts = uniqueValues([
    configuredPort,
    process.env.EXPO_PUBLIC_API_PORT,
    '8000',
    '8001',
    '8012',
  ]);

  const runtimeCandidates = runtimeHost
    ? candidatePorts.map((port) => `http://${runtimeHost}:${port}`)
    : [];

  return uniqueValues([
    initialApiBaseUrl,
    rewriteLoopbackUrl(configuredBaseUrl, runtimeHost),
    inferredBaseUrl,
    normalizeBaseUrl(fallbackHost),
    ...runtimeCandidates,
  ]).map((baseUrl) => baseUrl.replace(/\/+$/, ''));
}

async function resolveReachableApiBaseUrl() {
  const candidates = getApiBaseUrlCandidates();

  for (const candidate of candidates) {
    try {
      const response = await fetchWithTimeout(getHealthUrl(candidate));
      if (response?.ok) {
        resolvedApiBaseUrl = candidate;
        apiBaseUrlVerified = true;
        return resolvedApiBaseUrl;
      }
    } catch {
      // Try the next likely local/LAN backend URL.
    }
  }

  return resolvedApiBaseUrl;
}

export async function getApiBaseUrl() {
  if (apiBaseUrlVerified) {
    return resolvedApiBaseUrl;
  }

  if (!apiBaseUrlPromise) {
    apiBaseUrlPromise = resolveReachableApiBaseUrl().finally(() => {
      apiBaseUrlPromise = null;
    });
  }

  return apiBaseUrlPromise;
}

export async function getWsBaseUrl() {
  const baseUrl = await getApiBaseUrl();
  return baseUrl.replace(/^http/i, 'ws');
}

export function resolveMediaUrl(url) {
  if (!url) {
    return null;
  }

  const value = String(url).trim();
  if (/^(https?:|blob:|data:|file:|content:)/i.test(value)) {
    return value;
  }
  if (value.startsWith('//')) {
    return `${new URL(resolvedApiBaseUrl).protocol}${value}`;
  }
  return `${resolvedApiBaseUrl}/${value.replace(/^\/+/, '')}`;
}

let tokenRefreshPromise = null;
let authGeneration = 0;
let sessionExpiredHandler = null;

export function resetAuthSession() {
  authGeneration += 1;
  tokenRefreshPromise = null;
}

export function setSessionExpiredHandler(handler) {
  sessionExpiredHandler = handler;
}

function getTokenExpiration(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(globalThis.atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).exp;
  } catch {
    return null;
  }
}

function sessionChangedError() {
  const error = new Error('La sesion cambio durante la solicitud.');
  error.code = 'SESSION_CHANGED';
  return error;
}

export async function getAccessToken(forceRefresh = false) {
  const tokens = await secure.get('tokens');
  if (!tokens?.access) {
    return null;
  }

  const expiration = getTokenExpiration(tokens.access);
  if (!forceRefresh && (!expiration || expiration * 1000 > Date.now() + 30000)) {
    return tokens.access;
  }
  if (!tokens.refresh) {
    return tokens.access;
  }

  if (!tokenRefreshPromise) {
    const generation = authGeneration;
    const refresh = tokens.refresh;
    const pendingRefresh = (async () => {
      try {
        const baseURL = await getApiBaseUrl();
        // Use a separate request to avoid the authentication interceptors recursively refreshing.
        const response = await axios.post(`${baseURL}/chat/token/refresh/`, { refresh }, {
          timeout: 15000,
          headers: { 'Content-Type': 'application/json' },
        });
        const currentTokens = await secure.get('tokens');
        if (generation !== authGeneration || currentTokens?.refresh !== refresh) {
          throw sessionChangedError();
        }
        if (!response.data?.access) {
          throw new Error('Respuesta de sesion invalida.');
        }
        await secure.set('tokens', { ...currentTokens, ...response.data });
        return response.data.access;
      } catch (error) {
        if (generation === authGeneration && [401, 403].includes(error.response?.status)) {
          sessionExpiredHandler?.();
        }
        throw error;
      }
    })();
    tokenRefreshPromise = pendingRefresh;
    pendingRefresh.finally(() => {
      if (tokenRefreshPromise === pendingRefresh) {
        tokenRefreshPromise = null;
      }
    }).catch(() => null);
  }
  return tokenRefreshPromise;
}

function isPublicAuthRequest(config) {
  return /\/chat\/(signin|signup|token\/refresh|password-reset\/(?:request|confirm))\/?(?:\?|$)/.test(String(config.url || ''));
}

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(async (config) => {
  const generation = authGeneration;
  const nextHeaders = config.headers || {};
  const baseURL = await getApiBaseUrl();
  config._authGeneration = generation;
  if (!isPublicAuthRequest(config)) {
    const token = await getAccessToken();
    if (config._authGeneration !== authGeneration) {
      throw sessionChangedError();
    }
    if (token) {
      nextHeaders.Authorization = `Bearer ${token}`;
    }
  }

  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    if (typeof nextHeaders.delete === 'function') {
      // Prevent Axios from adding a default POST type; native fetch/XHR
      // must generate the multipart boundary together with the body.
      nextHeaders.set('Content-Type', false);
    } else {
      delete nextHeaders['Content-Type'];
      delete nextHeaders['content-type'];
    }
  }

  return {
    ...config,
    baseURL,
    headers: nextHeaders,
  };
});

api.interceptors.response.use(
  (response) => {
    if (!isPublicAuthRequest(response.config) && response.config._authGeneration !== authGeneration) {
      throw sessionChangedError();
    }
    return response;
  },
  async (error) => {
    const config = error.config;
    if (error.response?.status !== 401 || !config || isPublicAuthRequest(config)) {
      throw error;
    }
    if (config._authGeneration !== authGeneration) {
      throw sessionChangedError();
    }
    if (config._authRetried) {
      sessionExpiredHandler?.();
      throw error;
    }
    config._authRetried = true;
    const token = await getAccessToken(true);
    if (config._authGeneration !== authGeneration) {
      throw sessionChangedError();
    }
    if (!token) {
      sessionExpiredHandler?.();
      throw error;
    }
    config.headers.Authorization = `Bearer ${token}`;
    return api(config);
  }
);

export default api;
