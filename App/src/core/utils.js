import { Platform } from 'react-native';
import { resolveMediaUrl } from '../core/api';

/**
 * Imprime logs en consola, indicando la plataforma.
 */
function log(...args) {
  args.forEach(arg => {
    if (typeof arg === 'object') {
      arg = JSON.stringify(arg, null, 2);
    }
    console.log(`[${Platform.OS}]`, arg);
  });
}

/**
 * Devuelve la miniatura del usuario.
 * Si no se pasa URL, retorna null.
 */
function miniatura(url) {
  if (!url) {
    return null;
  }
  return { uri: resolveMediaUrl(url) };
}

/**
 * Devuelve un objeto source para la imagen obtenida del servidor.
 * Si no se pasa URL, retorna null.
 */
function getImage(url) {
  if (!url) {
    return null;
  }
  return { uri: resolveMediaUrl(url) };
}

/**
 * Devuelve un objeto source para el audio obtenido del servidor.
 * Si no se pasa URL, retorna null.
 */
function getAudio(url) {
  if (!url) {
    return null;
  }
  return { uri: resolveMediaUrl(url) };
}

/**
 * Devuelve un objeto source para el video obtenido del servidor.
 * Si no se pasa URL, retorna null.
 */
function getVideo(url) {
  if (!url) {
    return null;
  }
  return { uri: resolveMediaUrl(url) };
}

/**
 * Devuelve un objeto source para el documento obtenido del servidor.
 * Si no se pasa URL, retorna null.
 */
function getDocument(url) {
  if (!url) {
    return null;
  }
  return { uri: resolveMediaUrl(url) };
}

/**
 * Recibe una fecha y retorna una cadena formateada según el tiempo transcurrido.
 */
function formatTime(data) {
  if (data === null) {
    return '_';
  }
  const now = new Date();
  const s = Math.abs(now - new Date(data)) / 1000;

  if (s < 60) {
    return 'ahora';
  }
  if (s < 60 * 60) {
    const m = Math.floor(s / 60);
    return ` ${m}m`;
  }
  if (s < 60 * 60 * 24) {
    const h = Math.floor(s / (60 * 60));
    return ` ${h}h`;
  }
  if (s < 60 * 60 * 24 * 7) {
    const d = Math.floor(s / (60 * 60 * 24));
    return ` ${d}d`;
  }
  if (s < 60 * 60 * 24 * 7 * 4) {
    const w = Math.floor(s / (60 * 60 * 24 * 7));
    return ` ${w}s`;
  }
  const y = Math.floor(s / (60 * 60 * 24 * 365));
  return ` ${y}a`;
}

export { log, miniatura, formatTime, getImage, getAudio, getVideo, getDocument };






