import React, { memo } from 'react';
import {
  Modal, Platform, Pressable, ScrollView, StyleSheet, Text,
  TouchableOpacity, useWindowDimensions, View,
} from 'react-native';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faCamera, faImage } from '@fortawesome/free-solid-svg-icons';

const ImageSourcePicker = memo(({ visible, disabled = false, onGallery, onCamera, onClose, onDismiss }) => {
  const { height } = useWindowDimensions();
  if (!visible && Platform.OS !== 'ios') return null;
  const close = () => { if (!disabled) onClose?.(); };
  const select = (action) => { if (!disabled) action?.(); };
  const web = Platform.OS === 'web';

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} onDismiss={onDismiss} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={close} accessible={false} />
        <View style={[styles.card, { maxHeight: Math.max(180, height - 48) }]} accessibilityViewIsModal>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.title} accessibilityRole="header">Imágenes</Text>
            <Text style={styles.description}>Elige una imagen o toma una foto. Podrás revisarla antes de enviarla.</Text>
            <TouchableOpacity style={[styles.option, disabled && styles.disabled]} onPress={() => select(onGallery)}
              disabled={disabled || !onGallery} accessibilityRole="button" accessibilityLabel="Elegir de la galería"
              accessibilityState={{ disabled: disabled || !onGallery }}>
              <FontAwesomeIcon icon={faImage} size={22} color="#1D4ED8" />
              <Text style={styles.optionText}>Elegir de la galería</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.option, disabled && styles.disabled]} onPress={() => select(onCamera)}
              disabled={disabled || !onCamera} accessibilityRole="button" accessibilityLabel={web ? 'Cámara o archivo' : 'Tomar foto'}
              accessibilityState={{ disabled: disabled || !onCamera }}>
              <FontAwesomeIcon icon={faCamera} size={22} color="#1D4ED8" />
              <Text style={styles.optionText}>{web ? 'Cámara o archivo' : 'Tomar foto'}</Text>
            </TouchableOpacity>
            {web && <Text style={styles.hint}>En navegadores compatibles se abre la cámara; también puedes elegir una imagen.</Text>}
            <TouchableOpacity style={styles.cancel} onPress={close} disabled={disabled}
              accessibilityRole="button" accessibilityLabel="Cancelar selección de imagen" accessibilityState={{ disabled }}>
              <Text style={styles.cancelText}>Cancelar</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.5)', padding: 16 },
  card: { width: '100%', maxWidth: 420, borderRadius: 20, backgroundColor: '#fff', overflow: 'hidden' },
  scroll: { flexShrink: 1 },
  content: { padding: 20 },
  title: { fontSize: 21, fontWeight: '700', color: '#172554' },
  description: { fontSize: 15, lineHeight: 22, color: '#475569', marginTop: 8, marginBottom: 18 },
  option: { minHeight: 52, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#CBD5E1',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10 },
  optionText: { flex: 1, flexShrink: 1, fontSize: 16, fontWeight: '600', color: '#172554', marginLeft: 12 },
  hint: { fontSize: 13, lineHeight: 19, color: '#475569', marginBottom: 6 },
  cancel: { minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  cancelText: { fontSize: 16, fontWeight: '600', color: '#334155' },
  disabled: { opacity: 0.5 },
});

export default ImageSourcePicker;
