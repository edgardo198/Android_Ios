import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'chat.typingAnimationMode.v1';
const MODES = new Set(['system', 'on', 'off']);
let mode = 'system';
let loaded = false;
let loading = null;
let writes = Promise.resolve();
const listeners = new Set();

function publish(next) {
  mode = next;
  listeners.forEach((listener) => listener(mode));
}

export const getTypingAnimationMode = () => mode;

export function loadTypingAnimationMode() {
  if (loaded) return Promise.resolve(mode);
  if (loading) return loading;
  loading = (async () => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      publish(MODES.has(saved) ? saved : 'system');
    } catch {
      // A storage failure keeps the accessible system default.
    } finally {
      loaded = true;
    }
    return mode;
  })();
  return loading;
}

export function setTypingAnimationMode(next) {
  if (!MODES.has(next)) return Promise.reject(new Error('Selecciona una opción de animación válida.'));
  const pending = writes.catch(() => {}).then(async () => {
    // Finish the initial read before saving so it cannot undo a new selection.
    await loadTypingAnimationMode();
    try {
      await AsyncStorage.setItem(STORAGE_KEY, next);
    } catch {
      throw new Error('No se pudo guardar la opción. Intenta nuevamente.');
    }
    publish(next);
    return next;
  });
  writes = pending;
  return pending;
}

export function useTypingAnimationMode() {
  const [current, setCurrent] = useState(mode);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(mode);
    void loadTypingAnimationMode();
    return () => listeners.delete(setCurrent);
  }, []);
  return current;
}
