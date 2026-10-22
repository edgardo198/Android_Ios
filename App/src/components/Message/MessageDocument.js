import React, { memo, useState, useRef, useEffect } from 'react';
import { TouchableOpacity, View, ActivityIndicator, Text, StyleSheet, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { captureMediaSession, getMediaSource, isPrivateMediaSource } from '../../core/privateMedia';

const MessageDocument = memo(({ message = {} }) => {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  const openingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const handleOpen = async () => {
    if (!message.document || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      const session = captureMediaSession();
      const url = await getMediaSource(message.document, { forceRefresh: true });
      if (!mountedRef.current) return;
      if (isPrivateMediaSource(message.document)) session.assertActive();
      // Let the browser/viewer handle downloads. Android cannot open arbitrary app-private file:// paths.
      await Linking.openURL(url);
    } catch {
      if (mountedRef.current) setError('No se pudo abrir el documento. Verifica tu acceso e intenta nuevamente.');
    } finally {
      openingRef.current = false;
      if (mountedRef.current) setOpening(false);
    }
  };
  return (
    <TouchableOpacity onPress={handleOpen} disabled={opening || !message.document} accessibilityLabel="Abrir documento">
      <View style={styles.container}>
        {opening ? <ActivityIndicator color="#303040" /> : <Ionicons name="document-text-outline" size={42} color="#555" />}
        <Text style={styles.filename} numberOfLines={2}>{message.filename || 'Documento'}</Text>
        <Text style={styles.action}>Abrir o descargar</Text>
        {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      </View>
    </TouchableOpacity>
  );
});
const styles = StyleSheet.create({
  container: { width: 200, minHeight: 100, margin: 10, padding: 14, borderRadius: 10, backgroundColor: '#e0e0e0', alignItems: 'center' },
  filename: { fontSize: 14, marginTop: 5, color: '#333', textAlign: 'center' },
  action: { color: '#2563eb', fontSize: 12, marginTop: 8 },
  error: { color: '#b91c1c', fontSize: 12, marginTop: 8, textAlign: 'center' },
});
export default MessageDocument;
