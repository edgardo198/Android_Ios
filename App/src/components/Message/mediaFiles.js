import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { resolveMediaUrl } from '../../core/api';
import { captureMediaSession, getMediaSource, isPrivateMediaSource, mediaCacheIdentity } from '../../core/privateMedia';
import { filenameFromUri, getExtension, mediaCacheFilename } from './mediaMetadata';

const pendingDownloads = new Map();

export async function appendUploadFile(formData, asset, filename, mimeType) {
  if (Platform.OS !== 'web') {
    if (!asset?.uri) throw new Error('No se pudo leer el archivo seleccionado.');
    formData.append('file', { uri: asset.uri, name: filename, type: mimeType });
    return;
  }

  let blob = asset?.file;
  if (!(typeof Blob !== 'undefined' && blob instanceof Blob)) {
    if (!asset?.uri) throw new Error('No se pudo leer el archivo seleccionado.');
    const response = await fetch(asset.uri);
    if (!response.ok) throw new Error('No se pudo leer el archivo seleccionado.');
    blob = await response.blob();
  }
  formData.append('file', blob, filename);
}

export async function cachedMediaFile(source, filename) {
  const url = resolveMediaUrl(source);
  if (!url) throw new Error('El archivo no tiene una dirección válida.');
  if (/^(file:|content:|blob:|data:)/i.test(url)) return url;
  const privateFile = isPrivateMediaSource(source);
  const session = captureMediaSession();
  const downloadUrl = await getMediaSource(source);
  if (privateFile) session.assertActive();
  if (Platform.OS === 'web') return downloadUrl;
  if (!FileSystem.cacheDirectory) throw new Error('No se pudo acceder a la caché del dispositivo.');

  // A short noncryptographic filename hash cannot isolate private files between
  // accounts. Keep the full SHA-256 digest of account and stable attachment URL.
  const identity = mediaCacheIdentity(source);
  const cacheName = privateFile
    ? `chat-private-${await digestStringAsync(CryptoDigestAlgorithm.SHA256, identity)}.${getExtension(filename) || 'bin'}`
    : mediaCacheFilename(identity, filename);
  if (privateFile) session.assertActive();
  const fileUri = `${FileSystem.cacheDirectory}${cacheName}`;
  const downloadKey = privateFile ? `${fileUri}:${session.generation}` : fileUri;
  if (pendingDownloads.has(downloadKey)) return pendingDownloads.get(downloadKey);

  const download = (async () => {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (privateFile) session.assertActive();
    if (info.exists && info.size > 0) return fileUri;
    const temporaryUri = `${fileUri}.part${privateFile ? `-${session.generation}` : ''}`;
    try {
      let result = await FileSystem.downloadAsync(downloadUrl, temporaryUri);
      if (privateFile && [401, 403].includes(result.status)) {
        const refreshed = await getMediaSource(source, { forceRefresh: true });
        session.assertActive();
        result = await FileSystem.downloadAsync(refreshed, temporaryUri);
      }
      if (result.status < 200 || result.status >= 300) throw new Error('No se pudo descargar el archivo.');
      const downloaded = await FileSystem.getInfoAsync(temporaryUri);
      if (privateFile) session.assertActive();
      if (!downloaded.exists || !downloaded.size) throw new Error('El archivo descargado está vacío.');
      await FileSystem.moveAsync({ from: temporaryUri, to: fileUri });
      return fileUri;
    } finally {
      await FileSystem.deleteAsync(temporaryUri, { idempotent: true }).catch(() => {});
    }
  })();
  pendingDownloads.set(downloadKey, download);
  try { return await download; } finally { if (pendingDownloads.get(downloadKey) === download) pendingDownloads.delete(downloadKey); }
}

export async function saveMediaToGallery(source, filename, mediaType) {
  const url = resolveMediaUrl(source);
  if (!url) throw new Error('El archivo no tiene una dirección válida.');
  const privateFile = isPrivateMediaSource(source);
  const session = captureMediaSession();
  if (Platform.OS === 'web') {
    let downloadUrl = await getMediaSource(source);
    if (privateFile) session.assertActive();
    let response = await fetch(downloadUrl);
    if (privateFile && [401, 403].includes(response.status)) {
      downloadUrl = await getMediaSource(source, { forceRefresh: true });
      session.assertActive();
      response = await fetch(downloadUrl);
    }
    if (!response.ok) throw new Error('No se pudo descargar el archivo.');
    const blob = await response.blob();
    if (privateFile) session.assertActive();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || filenameFromUri(url);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return;
  }

  // The class API is native-only. Saving our own files on modern Android
  // doesn't require reading the user's photo library (also limited in Expo Go).
  const MediaLibrary = require('expo-media-library');
  if (Platform.OS !== 'android' || Number(Platform.Version) < 30) {
    const permission = Platform.OS === 'android'
      ? await MediaLibrary.requestPermissionsAsync(true, [])
      : await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) throw new Error('Activa el permiso para guardar archivos en la galería.');
  }
  const uri = await cachedMediaFile(source, filename || filenameFromUri(url));
  if (privateFile) session.assertActive();
  await MediaLibrary.Asset.create(uri);
}
