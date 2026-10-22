import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';

export const OUTBOX_LIMIT = 100;
export const TEXT_MESSAGE_LIMIT = 10000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mutations = new Map();

function storageKey(username) {
  // Usernames are case-sensitive on the server. Never share one account's queue.
  if (typeof username !== 'string' || !username.trim()) throw new Error('La sesión no tiene un usuario válido.');
  return `chat.outbox.v1:${encodeURIComponent(username.trim())}`;
}

function normalizeMessage(message, recover = false) {
  const connectionId = Number(message?.connectionId);
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const historyRevision = message?.historyRevision ?? 0;
  if (!UUID_PATTERN.test(message?.clientId || '') || !Number.isSafeInteger(connectionId) || connectionId <= 0 ||
      !text || text.length > TEXT_MESSAGE_LIMIT || !Number.isFinite(Date.parse(message?.created)) ||
      !Number.isSafeInteger(historyRevision) || historyRevision < 0) {
    throw new Error('La cola guardada contiene un mensaje inválido.');
  }
  const deliveryStatus = message.deliveryStatus === 'failed' ? 'failed'
    : !recover && message.deliveryStatus === 'sending' ? 'sending' : 'pending';
  return {
    id: `pending:${message.clientId.toLowerCase()}`,
    clientId: message.clientId.toLowerCase(),
    connectionId,
    historyRevision,
    text,
    type: 'text',
    created: message.created,
    is_me: true,
    isNew: false,
    deliveryStatus,
    ...(deliveryStatus === 'failed' && typeof message.deliveryError === 'string'
      ? { deliveryError: message.deliveryError.slice(0, 300) } : {}),
  };
}

function parseQueue(raw, recover = false) {
  if (!raw) return [];
  let saved;
  try { saved = JSON.parse(raw); } catch { throw new Error('No se pudo leer la cola guardada de mensajes.'); }
  if (saved?.version !== 1 || !Array.isArray(saved.messages) || saved.messages.length > OUTBOX_LIMIT) {
    throw new Error('La cola guardada de mensajes tiene un formato inválido.');
  }
  const seen = new Set();
  return saved.messages.map((message) => normalizeMessage(message, recover)).filter((message) => {
    if (seen.has(message.clientId)) return false;
    seen.add(message.clientId);
    return true;
  });
}

function serialize(username, operation) {
  const key = storageKey(username);
  const previous = mutations.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => operation(key));
  mutations.set(key, pending);
  pending.finally(() => {
    if (mutations.get(key) === pending) mutations.delete(key);
  }).catch(() => undefined);
  return pending;
}

function ensureActive(isActive) {
  if (!isActive()) {
    const error = new Error('La sesión cambió antes de guardar el mensaje.');
    error.code = 'SESSION_CHANGED';
    throw error;
  }
}

export function createPendingMessage(connectionId, text, historyRevision = 0) {
  return normalizeMessage({ connectionId, text, historyRevision, clientId: randomUUID(), created: new Date().toISOString() });
}

export function loadOutbox(username) {
  return serialize(username, async (key) => parseQueue(await AsyncStorage.getItem(key), true));
}

export function updateOutbox(username, transform, isActive = () => true) {
  return serialize(username, async (key) => {
    ensureActive(isActive);
    const queue = parseQueue(await AsyncStorage.getItem(key));
    ensureActive(isActive);
    const updated = transform(queue);
    if (!Array.isArray(updated) || updated.length > OUTBOX_LIMIT) {
      throw new Error(`Tienes ${OUTBOX_LIMIT} mensajes pendientes. Envía o descarta algunos antes de continuar.`);
    }
    const normalized = updated.map((message) => normalizeMessage(message));
    ensureActive(isActive);
    await AsyncStorage.setItem(key, JSON.stringify({ version: 1, messages: normalized }));
    return normalized;
  });
}

export function enqueueMessage(username, message, isActive) {
  return updateOutbox(username, (queue) => [...queue, message], isActive);
}
