import React, { memo, useEffect, useRef, useState } from 'react';
import { TouchableOpacity, View, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Video from './VideoPlayer';
import { saveMediaToGallery } from './mediaFiles';

const MessageVideo = memo(({ message = {} }) => {
  const videoUri = message.video;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const handleDownload = async () => {
    if (!videoUri || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await saveMediaToGallery(videoUri, message.filename, 'video');
      if (mountedRef.current) Alert.alert('Guardado', 'Video guardado.');
    } catch (error) {
      if (mountedRef.current) Alert.alert('Error', error.message || 'No se pudo guardar el video.');
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };
  return (
    <View style={styles.wrapper}>
      <View style={styles.container}>
        {videoUri && <Video source={{ uri: videoUri }} style={styles.video} useNativeControls resizeMode="contain" />}
        <TouchableOpacity style={styles.download} onPress={handleDownload} disabled={saving || !videoUri} accessibilityLabel="Guardar video">
          {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="download-outline" size={18} color="#fff" />}
        </TouchableOpacity>
      </View>
    </View>
  );
});
const styles = StyleSheet.create({
  wrapper: { alignItems: 'center', margin: 10 },
  container: { width: 200, height: 200, borderRadius: 10, backgroundColor: '#e0e0e0', overflow: 'hidden' },
  video: { width: '100%', height: '100%' },
  download: { position: 'absolute', top: 5, right: 5, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 15, padding: 6 },
});
export default MessageVideo;
