import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import api from '../../core/api';
import useRecording from '../../core/useRecording';
import useGlobal from '../../core/global';
import { normalizeApiError } from '../../common/apiError';
import { appendUploadFile } from './mediaFiles';
import { filenameFromUri, inferMimeType, replaceExtension, sanitizeFilename } from './mediaMetadata';
import { nextUploadProgress } from './uploadProgress';
import { isGifImage, prepareGifAsset } from './gifFiles';

async function prepareImage(asset) {
  const fileName = asset.fileName || filenameFromUri(asset.uri, `image-${Date.now()}.jpg`);
  const mimeType = asset.mimeType || inferMimeType(fileName, 'image/jpeg');
  if (isGifImage(fileName, mimeType)) return { ...asset, fileName, mimeType: 'image/gif' };
  if (Platform.OS === 'web') return { ...asset, fileName, mimeType };

  const format = mimeType === 'image/png' ? SaveFormat.PNG : SaveFormat.JPEG;
  const context = ImageManipulator.manipulate(asset.uri);
  let image;
  try {
    if (asset.width > 1600) context.resize({ width: 1600 });
    image = await context.renderAsync();
    const optimized = await image.saveAsync({ compress: 0.75, format });
    return {
      uri: optimized.uri,
      fileName: replaceExtension(fileName, format === SaveFormat.PNG ? 'png' : 'jpg'),
      mimeType: format === SaveFormat.PNG ? 'image/png' : 'image/jpeg',
    };
  } finally {
    image?.release();
    context.release();
  }
}

function releaseAsset(asset) {
  if (Platform.OS === 'web' && typeof asset?.uri === 'string' && asset.uri.startsWith('blob:')) {
    try { URL.revokeObjectURL(asset.uri); } catch { /* The picker URL may already have been released. */ }
  }
}

function assetPreview(type, asset) {
  if (!asset?.uri) throw new Error('No se pudo leer el archivo seleccionado.');
  const fileName = sanitizeFilename(asset.fileName || asset.name, filenameFromUri(asset.uri));
  const mimeType = asset.mimeType || asset.file?.type || inferMimeType(fileName);
  const size = asset.fileSize ?? asset.size ?? asset.file?.size;
  const duration = type === 'video' ? asset.duration / 1000 : asset.duration;
  return {
    type,
    asset: { ...asset, fileName, mimeType },
    fileName,
    mimeType,
    ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
    ...(Number.isFinite(duration) && duration >= 0 ? { duration } : {}),
  };
}

function historyRevision(state, connectionId) {
  const revision = state.conversationHistory?.[String(connectionId)]?.revision;
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export default function useMessageMedia(connectionId, onUploaded) {
  const { isRecording, isPreparingRecording, startRecording, stopRecording, cancelRecording } = useRecording();
  const ingestMessagePayload = useGlobal((state) => state.ingestMessagePayload);
  const [isBusy, setIsBusy] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const actionRef = useRef(null);
  const previewRef = useRef(null);
  const previewContextRef = useRef(null);
  const mountedRef = useRef(true);
  const focusedRef = useRef(false);
  const focusGenerationRef = useRef(0);
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;

  const clearPreview = useCallback((release = true) => {
    if (release) releaseAsset(previewRef.current?.asset);
    previewRef.current = null;
    previewContextRef.current = null;
    if (mountedRef.current) {
      setPreview(null);
      setPreviewError(null);
      setUploadProgress(null);
    }
  }, []);

  const invalidateSelection = useCallback(() => {
    focusGenerationRef.current += 1;
    const uploading = actionRef.current?.kind === 'upload';
    if (uploading) {
      actionRef.current.releaseOnFinish = true;
      actionRef.current.controller.abort();
    }
    actionRef.current = null;
    // A started preparation/request may still read this URI; release it when that operation ends.
    clearPreview(!uploading);
    if (mountedRef.current) {
      setIsBusy(false);
      setIsUploading(false);
    }
  }, [clearPreview]);

  const isCurrent = useCallback((context) => {
    const state = useGlobal.getState();
    return mountedRef.current && focusedRef.current && context?.generation === focusGenerationRef.current &&
      String(context.connectionId) === String(connectionRef.current) && state.authenticated &&
      state.user?.username === context.username && historyRevision(state, context.connectionId) === context.historyRevision;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateSelection();
    };
  }, [invalidateSelection]);

  useEffect(() => useGlobal.subscribe((state, previous) => {
    if (!state.authenticated || state.user?.username !== previous.user?.username ||
      historyRevision(state, connectionRef.current) !== historyRevision(previous, connectionRef.current)) {
      invalidateSelection();
      void cancelRecording();
    }
  }), [cancelRecording, invalidateSelection]);

  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    focusGenerationRef.current += 1;
    return () => {
      focusedRef.current = false;
      invalidateSelection();
      void cancelRecording();
    };
  }, [cancelRecording, connectionId, invalidateSelection]));

  const runAction = useCallback(async (action, kind = 'picker') => {
    const state = useGlobal.getState();
    if (actionRef.current || previewRef.current || !focusedRef.current || !mountedRef.current ||
      !state.authenticated || isPreparingRecording || (isRecording && kind === 'picker')) return false;
    const context = { generation: focusGenerationRef.current, connectionId, username: state.user?.username,
      historyRevision: historyRevision(state, connectionId) };
    const operation = { kind, context };
    actionRef.current = operation;
    setIsBusy(true);
    setPreviewError(null);
    setUploadProgress(null);
    try {
      return await action(context);
    } catch (error) {
      if (isCurrent(context)) setPreviewError(normalizeApiError(error.response?.data,
        error.response ? 'Intenta nuevamente.' : error.message || 'Verifica tu conexión e intenta nuevamente.'));
      return false;
    } finally {
      if (actionRef.current === operation) {
        actionRef.current = null;
        if (mountedRef.current) setIsBusy(false);
      }
    }
  }, [connectionId, isCurrent, isPreparingRecording, isRecording]);

  const selectAsset = useCallback((type, asset, context) => {
    if (!isCurrent(context)) { releaseAsset(asset); return false; }
    const selected = assetPreview(type, asset);
    previewRef.current = selected;
    previewContextRef.current = context;
    setPreview(selected);
    setPreviewError(null);
    return true;
  }, [isCurrent]);

  const guardSelection = useCallback((action) => {
    const state = useGlobal.getState();
    const context = { generation: focusGenerationRef.current, connectionId, username: state.user?.username,
      historyRevision: historyRevision(state, connectionId) };
    let used = false;
    return () => {
      if (used) return false;
      used = true;
      return isCurrent(context) && typeof action === 'function' ? action() : false;
    };
  }, [connectionId, isCurrent]);

  const onImage = useCallback(() => runAction(async (context) => {
    // The system picker grants access to the selected file without requesting the entire library.
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    return !result.canceled && result.assets?.[0] ? selectAsset('image', result.assets[0], context) : false;
  }), [runAction, selectAsset]);

  const onCamera = useCallback(() => runAction(async (context) => {
    if (Platform.OS !== 'web') {
      let permission = await ImagePicker.getCameraPermissionsAsync();
      if (!isCurrent(context)) return false;
      if (!permission.granted && permission.canAskAgain !== false) {
        permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!isCurrent(context)) return false;
      }
      if (!permission.granted) {
        throw new Error(permission.canAskAgain === false
          ? 'Permite el acceso a la cámara desde los ajustes de la app para tomar una foto. También puedes elegir una imagen de la galería.'
          : 'Para tomar una foto, permite el acceso a la cámara e intenta nuevamente. También puedes usar la galería.');
      }
    }
    // On web, launch immediately inside the user's gesture. HTML capture is a hint,
    // so browsers without camera capture can still select an existing image.
    let result;
    try {
      result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'], cameraType: 'back', quality: 1, allowsEditing: false,
      });
    } catch {
      throw new Error('No se pudo abrir la cámara. Intenta nuevamente o elige una imagen de la galería.');
    }
    return !result.canceled && result.assets?.[0] ? selectAsset('image', result.assets[0], context) : false;
  }), [isCurrent, runAction, selectAsset]);

  const onVideo = useCallback(() => runAction(async (context) => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 });
    return !result.canceled && result.assets?.[0] ? selectAsset('video', result.assets[0], context) : false;
  }), [runAction, selectAsset]);

  const onSelectGif = useCallback(() => runAction(async (context) => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true, multiple: false, type: 'image/gif', base64: false,
    });
    const asset = !result.canceled && result.assets?.[0];
    if (!asset) return false;
    if (!isCurrent(context)) { releaseAsset(asset); return false; }
    try {
      return selectAsset('image', await prepareGifAsset(asset), context);
    } catch (error) {
      releaseAsset(asset);
      throw error;
    }
  }), [isCurrent, runAction, selectAsset]);

  const onDocument = useCallback(() => runAction(async (context) => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: '*/*', base64: false });
    return !result.canceled && result.assets?.[0] ? selectAsset('document', result.assets[0], context) : false;
  }), [runAction, selectAsset]);

  const onAudio = useCallback(() => runAction(async (context) => {
    if (Platform.OS === 'web') {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: 'audio/*', base64: false });
      return !result.canceled && result.assets?.[0] ? selectAsset('audio', result.assets[0], context) : false;
    }
    if (!isRecording) return await startRecording();
    const asset = await stopRecording();
    if (!asset?.uri) throw new Error('No se pudo obtener el audio grabado.');
    return selectAsset('audio', asset, context);
  }, 'recording'), [isRecording, runAction, selectAsset, startRecording, stopRecording]);

  const cancelPreview = useCallback(() => {
    if (actionRef.current?.kind === 'upload') return false;
    clearPreview();
    return true;
  }, [clearPreview]);

  const cancelUpload = useCallback(() => {
    const operation = actionRef.current;
    if (operation?.kind !== 'upload' || operation.confirmed || operation.controller.signal.aborted) return false;
    operation.controller.abort();
    if (isCurrent(operation.context)) {
      operation.progress = { ...operation.progress, phase: 'cancelled' };
      setUploadProgress(operation.progress);
      setPreviewError(operation.requestStarted
        ? 'Subida detenida. Si el archivo ya llegó al servidor, puede aparecer en el chat. Revisa antes de reintentar.'
        : 'Preparación detenida. El archivo no se envió. Puedes revisar o intentar nuevamente.');
    }
    return true;
  }, [isCurrent]);

  const confirmPreview = useCallback(async () => {
    const selected = previewRef.current;
    const context = previewContextRef.current;
    if (!selected || actionRef.current || !isCurrent(context)) return false;
    const operation = { kind: 'upload', context, controller: new AbortController(),
      progress: { phase: 'preparing', loaded: 0, total: null }, requestStarted: false, confirmed: false };
    actionRef.current = operation;
    setIsBusy(true);
    setIsUploading(true);
    setPreviewError(null);
    setUploadProgress(operation.progress);
    const active = () => actionRef.current === operation && isCurrent(context) && !operation.controller.signal.aborted;
    try {
      if (!context.connectionId) throw new Error('La conversación no es válida. Regresa y ábrela nuevamente.');
      // Keep the original selection visible if compression or upload fails.
      const asset = selected.type === 'image' ? await prepareImage(selected.asset) : selected.asset;
      if (!active()) return false;
      const fileName = sanitizeFilename(asset.fileName || asset.name, selected.fileName);
      const mimeType = asset.mimeType || selected.mimeType;
      const formData = new FormData();
      formData.append('connectionId', String(context.connectionId));
      formData.append('historyRevision', String(context.historyRevision));
      formData.append('type', selected.type);
      await appendUploadFile(formData, asset, fileName, mimeType);
      if (!active()) return false;
      operation.requestStarted = true;
      operation.progress = { phase: 'uploading', loaded: 0, total: null };
      setUploadProgress(operation.progress);
      const response = await api.post('/chat/messages/media/', formData, {
        timeout: 300000,
        signal: operation.controller.signal,
        onUploadProgress(event) {
          if (!active()) return;
          operation.progress = nextUploadProgress(event, operation.progress);
          setUploadProgress(operation.progress);
        },
      });
      if (!active()) return false;
      if (!Number.isSafeInteger(response?.data?.message?.id) || response.data.message.id <= 0) {
        throw new Error('El servidor no confirmó el archivo. Revisa el chat antes de reintentar.');
      }
      operation.confirmed = true;
      operation.progress = { ...operation.progress, phase: 'confirmed' };
      ingestMessagePayload(response.data);
      clearPreview();
      setUploadProgress(operation.progress);
      onUploaded?.();
      return true;
    } catch (error) {
      if (isCurrent(context) && !operation.controller.signal.aborted) {
        operation.progress = { ...operation.progress, phase: 'failed' };
        setUploadProgress(operation.progress);
        setPreviewError(normalizeApiError(error.response?.data,
          error.response ? 'Intenta nuevamente.' : operation.requestStarted
            ? 'No recibimos confirmación del envío. El archivo puede haber llegado; revisa el chat antes de reintentar.'
            : error.message || 'Verifica tu conexión e intenta nuevamente.'));
      }
      return false;
    } finally {
      if (operation.releaseOnFinish) releaseAsset(selected.asset);
      if (actionRef.current === operation) {
        actionRef.current = null;
        if (mountedRef.current) { setIsBusy(false); setIsUploading(false); }
      }
    }
  }, [clearPreview, ingestMessagePayload, isCurrent, onUploaded]);

  return {
    onImage, onCamera, onVideo, onDocument, onAudio, onSelectGif, guardSelection, onCancelRecording: cancelRecording,
    isRecording, isBusy: isBusy || isPreparingRecording,
    preview, previewError, isUploading, uploadProgress, confirmPreview, cancelPreview, cancelUpload,
  };
}
