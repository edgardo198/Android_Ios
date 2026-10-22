import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function GifViewer({ uri, visible, onRequestClose }) {
  const insets = useSafeAreaInsets();
  if (!visible || !uri) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onRequestClose}>
      <View style={[styles.overlay, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]} accessibilityViewIsModal>
        <TouchableOpacity style={styles.close} onPress={onRequestClose} accessibilityRole="button" accessibilityLabel="Cerrar GIF">
          <Text style={styles.closeText}>Cerrar</Text>
        </TouchableOpacity>
        <Image source={{ uri, isAnimated: true }} contentFit="contain" autoplay cachePolicy="none" style={styles.image} accessibilityLabel="GIF animado" />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', paddingHorizontal: 16 },
  close: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, marginBottom: 8 },
  closeText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  image: { flex: 1, width: '100%', minHeight: 0 },
});
