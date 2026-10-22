import { filenameFromUri, getExtension, sanitizeFilename } from './mediaMetadata';

export const GIF_MAX_BYTES = 10 * 1024 * 1024;

export function isGifImage(filename, mimeType) {
  return getExtension(filename) === 'gif' || String(mimeType || '').toLowerCase() === 'image/gif';
}

export async function prepareGifAsset(asset) {
  if (!asset?.uri || !/^(file:|content:|blob:)/i.test(asset.uri)) {
    throw new Error('Selecciona un archivo GIF de tu dispositivo.');
  }
  const fileName = sanitizeFilename(asset.fileName || asset.name, filenameFromUri(asset.uri));
  if (getExtension(fileName) !== 'gif') throw new Error('Selecciona un archivo con extensión .gif.');
  const mimeType = String(asset.mimeType || asset.file?.type || '').toLowerCase();
  if (mimeType && !['image/gif', 'application/octet-stream'].includes(mimeType)) {
    throw new Error('El archivo seleccionado no tiene formato GIF.');
  }
  const size = asset.file?.size ?? asset.fileSize ?? asset.size;
  if (size === 0) throw new Error('El archivo GIF está vacío.');
  if (Number.isFinite(size) && size > GIF_MAX_BYTES) throw new Error('El GIF supera el límite de 10 MB.');
  // On web, inspect the original File without converting its frames or creating
  // another URL. Native providers are checked by the server's image decoder.
  if (typeof asset.file?.slice === 'function') {
    const bytes = new Uint8Array(await asset.file.slice(0, 6).arrayBuffer());
    const header = String.fromCharCode(...bytes);
    if (!['GIF87a', 'GIF89a'].includes(header)) throw new Error('El archivo seleccionado no tiene formato GIF.');
  }
  return { ...asset, fileName, mimeType: 'image/gif' };
}
