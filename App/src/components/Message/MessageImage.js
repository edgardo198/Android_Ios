import React, { useEffect, useState, memo, useRef } from 'react';
import { TouchableOpacity, View, ActivityIndicator, StyleSheet, Text, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import ImageViewer from './ImageViewer';
import usePrivateMediaSource from '../../core/usePrivateMediaSource';
import { captureMediaSession, getMediaSource, isPrivateMediaSource } from '../../core/privateMedia';
import { saveMediaToGallery } from './mediaFiles';
import { isGifImage } from './gifFiles';
import GifViewer from './GifViewer';

const MessageImage = memo(({ message = {} }) => {
  const media = usePrivateMediaSource(message.image);
  const imageUri = media.uri;
  const isGif = isGifImage(message.filename);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [viewerUri, setViewerUri] = useState(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    setLoaded(false);
    setHasError(false);
    setIsVisible(false);
    setViewerUri(null);
  }, [imageUri, media.version]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const handleOpen = async () => {
    if (openingRef.current || !message.image) return;
    openingRef.current = true;
    setOpening(true);
    const session = captureMediaSession();
    try {
      const uri = await getMediaSource(message.image);
      if (!mountedRef.current) return;
      if (isPrivateMediaSource(message.image)) session.assertActive();
      setViewerUri(uri);
      setIsVisible(true);
    } catch {
      if (mountedRef.current) setHasError(true);
    } finally {
      openingRef.current = false;
      if (mountedRef.current) setOpening(false);
    }
  };
  const handleDownload = async () => {
    if (!message.image || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await saveMediaToGallery(message.image, message.filename, 'image');
      if (mountedRef.current) Alert.alert('Guardado', isGif ? 'GIF guardado.' : 'Imagen guardada.');
    } catch (error) {
      if (mountedRef.current) Alert.alert('Error', error.message || 'No se pudo guardar la imagen.');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };
  return (
    <View style={styles.wrapper}>
      <View style={styles.container}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          onPress={handleOpen}
          disabled={!imageUri || !loaded || hasError || opening}
          accessibilityLabel={isGif ? 'Abrir GIF' : 'Abrir imagen'}
        >
          {imageUri && (
            <ExpoImage
              key={`${imageUri}:${media.version}`}
              style={styles.image}
              source={{ uri: imageUri, ...(isGif ? { isAnimated: true } : {}) }}
              contentFit="cover"
              autoplay
              cachePolicy={media.isPrivate ? 'none' : 'memory-disk'}
              transition={150}
              onLoad={() => setLoaded(true)}
              onError={() => { setHasError(true); setLoaded(true); }}
            />
          )}
        </TouchableOpacity>
        {(opening || media.loading || (!loaded && !hasError && !media.error)) && <ActivityIndicator size="small" color="#303040" />}
        {(hasError || media.error) && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText} accessibilityRole="alert">{media.error || 'No se pudo cargar la imagen.'}</Text>
            <TouchableOpacity style={styles.retry} onPress={() => media.reload()} disabled={media.loading} accessibilityRole="button" accessibilityLabel="Reintentar imagen">
              <Text style={styles.retryText}>Reintentar</Text>
            </TouchableOpacity>
          </View>
        )}
        {loaded && !hasError && (
          <TouchableOpacity style={styles.download} onPress={handleDownload} disabled={saving} accessibilityLabel={isGif ? 'Guardar GIF' : 'Guardar imagen'}>
            {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="download-outline" size={18} color="#fff" />}
          </TouchableOpacity>
        )}
      </View>
      {imageUri && (isGif
        ? <GifViewer uri={viewerUri || imageUri} visible={isVisible} onRequestClose={() => setIsVisible(false)} />
        : <ImageViewer images={[{ uri: viewerUri || imageUri }]} imageIndex={0} visible={isVisible} onRequestClose={() => setIsVisible(false)} />)}
    </View>
  );
});
const styles = StyleSheet.create({
  wrapper: { alignItems: 'center', margin: 10 },
  container: { width: 200, height: 200, borderRadius: 10, backgroundColor: '#e0e0e0', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  image: { width: 200, height: 200 },
  errorText: { color: '#b91c1c', fontSize: 12, padding: 12 },
  errorContainer: { alignItems: 'center' },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  retryText: { color: '#155EA0', fontSize: 13, fontWeight: '600' },
  download: { position: 'absolute', top: 5, right: 5, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 15, padding: 6 },
});
export default MessageImage;
