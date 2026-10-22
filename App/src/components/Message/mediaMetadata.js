const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', caf: 'audio/x-caf',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', zip: 'application/zip',
};

export function sanitizeFilename(name, fallback = 'archivo') {
  const candidate = typeof name === 'string' ? name.trim() : '';
  const fallbackName = typeof fallback === 'string' ? fallback : 'archivo';
  const basename = (candidate || fallbackName).split(/[\\/]/).pop() || '';
  const safe = basename.replace(/[^\w.\-]/g, '_').replace(/^\.+/, '');
  return safe || 'archivo';
}

export function filenameFromUri(uri, fallback = 'archivo') {
  const path = typeof uri === 'string' ? uri.split(/[?#]/)[0] : '';
  let name = path.split('/').pop();
  try { name = decodeURIComponent(name || ''); } catch { /* Keep a malformed URI readable. */ }
  return sanitizeFilename(name, fallback);
}

export function getExtension(value) {
  const filename = filenameFromUri(value, '');
  const match = filename.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

export function inferMimeType(filename, fallback = 'application/octet-stream') {
  const extension = getExtension(filename);
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXTENSION, extension) ? MIME_BY_EXTENSION[extension] : fallback;
}

export function replaceExtension(filename, extension) {
  const safe = sanitizeFilename(filename);
  return `${safe.replace(/\.[^.]+$/, '')}.${extension}`;
}

export function mediaCacheFilename(url, filename) {
  // Include the entire URL so repeated filenames do not reuse an earlier upload.
  let hash = 2166136261;
  for (const character of String(url)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `chat-${(hash >>> 0).toString(16)}-${sanitizeFilename(filename, filenameFromUri(url))}`;
}

export function messagePreview(message, fallback = '') {
  const mediaLabels = { image: '[Imagen]', audio: '[Audio]', video: '[Video]', document: '[Documento]' };
  const mediaType = message?.type || Object.keys(mediaLabels).find((type) => message?.[type]);
  return Object.prototype.hasOwnProperty.call(mediaLabels, mediaType) ? mediaLabels[mediaType] : message?.text || fallback || 'Nueva conexión';
}
