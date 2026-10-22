import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Serialize writes so a pending token update cannot complete after a logout wipe.
let mutationQueue = Promise.resolve();

function mutate(operation) {
  const pending = mutationQueue.then(operation);
  mutationQueue = pending.catch(() => null);
  return pending;
}

function getWebStorage() {
  if (Platform.OS !== 'web') {
    return null;
  }
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('El navegador no permite guardar la sesion.');
  }
  return globalThis.localStorage;
}

function set(key, object) {
  return mutate(async () => {
    const payload = JSON.stringify(object);
    const webStorage = getWebStorage();
    if (webStorage) {
      webStorage.setItem(key, payload);
    } else {
      await SecureStore.setItemAsync(key, payload);
    }
  });
}

async function get(key) {
  try {
    await mutationQueue;
    const webStorage = getWebStorage();
    const data = webStorage ? webStorage.getItem(key) : await SecureStore.getItemAsync(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.warn('No se pudo leer la sesion guardada:', error?.message || error);
    return null;
  }
}

function remove(key) {
  return mutate(async () => {
    const webStorage = getWebStorage();
    if (webStorage) {
      webStorage.removeItem(key);
    } else {
      await SecureStore.deleteItemAsync(key);
    }
  });
}

function wipe() {
  return mutate(async () => {
    const webStorage = getWebStorage();
    const results = await Promise.allSettled(['credentials', 'tokens', 'user'].map((key) => (
      webStorage ? Promise.resolve().then(() => webStorage.removeItem(key)) : SecureStore.deleteItemAsync(key)
    )));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  });
}

export default { set, get, remove, wipe };

