import React, { memo, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, Keyboard, Modal, Platform, ScrollView,
  StyleSheet, Text, TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faFile } from '@fortawesome/free-solid-svg-icons';
import AudioPlayer from './AudioPlayer';
import VideoPlayer from './VideoPlayer';
import { getExtension } from './mediaMetadata';
import { Image as ExpoImage } from 'expo-image';
import { isGifImage } from './gifFiles';

export function formatAttachmentSize(size) {
  if (size === undefined || size === null || !Number.isFinite(Number(size)) || Number(size) < 0) return 'Tamaño no disponible';
  const bytes = Number(size);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AttachmentPreview = memo(({ preview, previewError, isUploading = false, uploadProgress, onConfirm, onCancel, onCancelUpload }) => {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [stopping, setStopping] = useState(false);
  const confirmationInFlight = useRef(false);
  const cancellationRequested = useRef(false);
  const mounted = useRef(true);
  const busy = isUploading || confirming;
  const availableHeight = Math.max(180, height - insets.top - insets.bottom - 32);
  const visualHeight = Math.max(120, Math.min(300, availableHeight * 0.48));
  const fileName = preview?.fileName || 'Archivo seleccionado';
  const uri = preview?.asset?.uri;
  const extension = getExtension(fileName).toUpperCase();
  const size = preview?.size ?? preview?.asset?.fileSize ?? preview?.asset?.size ?? preview?.asset?.file?.size;
  const titles = { image: 'Imagen seleccionada', video: 'Video seleccionado', audio: 'Audio seleccionado', document: 'Documento seleccionado' };
  const isGif = preview?.type === 'image' && isGifImage(fileName, preview?.mimeType);
  const title = isGif ? 'GIF seleccionado' : titles[preview?.type] || 'Archivo seleccionado';
  const phase = uploadProgress?.phase || (busy ? 'preparing' : null);
  const percent = Number.isFinite(uploadProgress?.percent) ? Math.max(0, Math.min(100, uploadProgress.percent)) : null;
  const progressLabels = {
    preparing: 'Preparando archivo…', uploading: 'Subiendo archivo…',
    processing: 'Esperando confirmación del servidor…', confirmed: 'Archivo confirmado',
    cancelled: busy ? 'Deteniendo subida…' : 'Subida detenida', failed: 'No se confirmó el envío',
  };
  const progressLabel = progressLabels[phase] || 'Subiendo archivo…';
  const uploadedBytes = formatAttachmentSize(uploadProgress?.loaded ?? 0);
  const totalBytes = uploadProgress?.total ? formatAttachmentSize(uploadProgress.total) : null;
  const progressDescription = `${progressLabel}${percent !== null ? ` ${percent}%` : ''}`;

  useEffect(() => {
    mounted.current = true;
    Keyboard.dismiss();
    return () => { mounted.current = false; };
  }, []);

  const cancel = () => {
    if (!isUploading && !confirmationInFlight.current) onCancel?.();
  };

  const confirm = async () => {
    if (isUploading || confirmationInFlight.current || !onConfirm) return;
    confirmationInFlight.current = true;
    cancellationRequested.current = false;
    setStopping(false);
    setConfirming(true);
    setLocalError(null);
    try { await onConfirm(); } catch {
      if (mounted.current) setLocalError('No se pudo enviar el archivo. Verifica tu conexión e intenta nuevamente.');
    } finally {
      confirmationInFlight.current = false;
      if (mounted.current) setConfirming(false);
    }
  };

  const stopUpload = () => {
    if (cancellationRequested.current || !onCancelUpload) return;
    cancellationRequested.current = true;
    setStopping(true);
    if (onCancelUpload() === false) {
      cancellationRequested.current = false;
      setStopping(false);
    }
  };

  const canStop = busy && !!onCancelUpload;
  const cancelDisabled = canStop ? stopping || phase === 'cancelled' || phase === 'confirmed' : busy || !onCancel;

  if (!preview) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={cancel} statusBarTranslucent>
      <View style={[styles.backdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <View style={[styles.card, { maxHeight: availableHeight }]} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text style={styles.heading} accessibilityRole="header">Vista previa</Text>
            <Text style={styles.subtitle}>{title}</Text>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {preview.type === 'image' && (isGif ? (
              <ExpoImage
                source={{ uri, isAnimated: true }}
                contentFit="contain"
                autoplay
                cachePolicy="none"
                style={[styles.visual, { height: visualHeight }]}
                accessibilityLabel={`Vista previa de ${fileName}`}
                onError={() => setLocalError('No se pudo mostrar el GIF seleccionado.')}
              />
            ) : (
              <Image
                source={{ uri }}
                resizeMode="contain"
                style={[styles.visual, { height: visualHeight }]}
                accessibilityLabel={`Vista previa de ${fileName}`}
                onError={() => setLocalError('No se pudo mostrar la imagen seleccionada.')}
              />
            ))}
            {(preview.type === 'video' || preview.type === 'audio') && busy ? (
              <View style={[styles.mediaPlaceholder, preview.type === 'video' && { height: visualHeight }]}>
                <ActivityIndicator color="#155EA0" />
                <Text style={styles.metadata}>{progressLabel}</Text>
              </View>
            ) : preview.type === 'video' ? (
              <VideoPlayer source={{ uri }} style={[styles.visual, { height: visualHeight }]} resizeMode="contain" useNativeControls />
            ) : preview.type === 'audio' ? (
              <View style={styles.audio}><AudioPlayer audioUri={uri} /></View>
            ) : null}
            {preview.type === 'document' && (
              <View style={styles.document}>
                <FontAwesomeIcon icon={faFile} size={48} color="#155EA0" />
                <Text style={styles.documentType} numberOfLines={1}>{extension || 'ARCHIVO'}</Text>
              </View>
            )}
            <Text style={styles.fileName} numberOfLines={3} accessibilityLabel={`Archivo seleccionado: ${fileName}`}>{fileName}</Text>
            <Text style={styles.metadata}>{extension ? `${extension} · ` : ''}{formatAttachmentSize(size)}</Text>
            {(uploadProgress || busy) && (
              <View style={styles.progress}>
                <Text style={styles.progressText} accessibilityLiveRegion="polite">{progressDescription}</Text>
                <View
                  style={styles.progressTrack}
                  accessible
                  accessibilityRole="progressbar"
                  accessibilityLabel="Progreso de subida"
                  accessibilityValue={{ min: 0, max: 100, ...(percent !== null ? { now: percent } : {}), text: progressDescription }}
                  accessibilityState={{ busy }}
                  {...(Platform.OS === 'web' ? {
                    'aria-valuemin': 0, 'aria-valuemax': 100,
                    'aria-valuenow': percent ?? undefined, 'aria-valuetext': progressDescription,
                    'aria-busy': busy,
                  } : {})}
                >
                  {percent !== null ? <View style={[styles.progressFill, { width: `${percent}%` }]} />
                    : <ActivityIndicator size="small" color="#155EA0" />}
                </View>
                {phase !== 'preparing' && (
                  <Text style={styles.metadata}>{totalBytes ? `${uploadedBytes} de ${totalBytes}` : `${uploadedBytes} enviados · total no disponible`}</Text>
                )}
              </View>
            )}
            {(previewError || localError) && (
              <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{previewError || localError}</Text>
            )}
          </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton, cancelDisabled && styles.disabled]}
              onPress={canStop ? stopUpload : cancel}
              disabled={cancelDisabled}
              accessibilityRole="button"
              accessibilityLabel={canStop ? 'Detener subida' : 'Cancelar vista previa'}
              accessibilityState={{ disabled: cancelDisabled }}
            >
              <Text style={styles.cancelText}>{canStop ? stopping || phase === 'cancelled' ? 'Deteniendo…' : 'Detener subida' : 'Cancelar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.sendButton, busy && styles.disabled]}
              onPress={confirm}
              disabled={busy || !onConfirm}
              accessibilityRole="button"
              accessibilityLabel={busy ? 'Enviando archivo' : 'Enviar archivo'}
              accessibilityState={{ disabled: busy || !onConfirm, busy }}
            >
              {busy && <ActivityIndicator color="#FFFFFF" size="small" />}
              <Text style={styles.sendText}>{busy ? 'Enviando…' : 'Enviar archivo'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(16, 33, 49, 0.6)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16 },
  card: { width: '100%', maxWidth: 560, minHeight: 0, borderRadius: 20, backgroundColor: '#FFFFFF', overflow: 'hidden' },
  header: { flexShrink: 0, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 14 },
  heading: { color: '#163B5D', fontSize: 21, fontWeight: '700' },
  subtitle: { color: '#586D80', fontSize: 14, marginTop: 4 },
  scroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  content: { paddingHorizontal: 20, paddingBottom: 18 },
  visual: { width: '100%', backgroundColor: '#EEF3F8', borderRadius: 12, overflow: 'hidden' },
  audio: { width: '100%', minWidth: 0, backgroundColor: '#EEF3F8', padding: 12, borderRadius: 12 },
  mediaPlaceholder: { minHeight: 96, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#EEF3F8', borderRadius: 12 },
  document: { backgroundColor: '#EEF3F8', alignItems: 'center', justifyContent: 'center', padding: 24, borderRadius: 12, gap: 10 },
  documentType: { color: '#365C78', fontSize: 13, fontWeight: '700', maxWidth: '100%' },
  fileName: { color: '#163B5D', fontSize: 16, fontWeight: '600', marginTop: 14, lineHeight: 22, flexShrink: 1, ...Platform.select({ web: { overflowWrap: 'anywhere' } }) },
  metadata: { color: '#586D80', fontSize: 13, marginTop: 5, ...Platform.select({ web: { overflowWrap: 'anywhere' } }) },
  progress: { marginTop: 16, gap: 6 },
  progressText: { color: '#365C78', fontSize: 13, lineHeight: 19, fontWeight: '600' },
  progressTrack: { minHeight: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: '#E4EDF5', justifyContent: 'center' },
  progressFill: { height: 12, backgroundColor: '#155EA0', borderRadius: 6 },
  error: { color: '#8B2424', fontSize: 14, lineHeight: 20, marginTop: 12 },
  footer: { flexShrink: 0, flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 16, borderTopWidth: 1, borderTopColor: '#E6EDF3' },
  button: { flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 12 },
  sendButton: { backgroundColor: '#155EA0' },
  cancelButton: { backgroundColor: '#EEF3F8' },
  sendText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', flexShrink: 1 },
  cancelText: { color: '#365C78', fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.65 },
});

export default AttachmentPreview;
