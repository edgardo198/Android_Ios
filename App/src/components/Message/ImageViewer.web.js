import React from 'react';
import { Modal, StyleSheet, TouchableOpacity, View, Image } from 'react-native';

function ImageViewer({ images = [], visible = false, onRequestClose }) {
  const currentImage = images[0]?.uri;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <TouchableOpacity activeOpacity={1} style={styles.overlay} onPress={onRequestClose}>
        <View style={styles.content}>
          {currentImage ? <Image source={{ uri: currentImage }} style={styles.image} /> : null}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain',
  },
});

export default ImageViewer;
