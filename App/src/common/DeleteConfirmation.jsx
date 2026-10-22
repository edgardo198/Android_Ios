import React from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function DeleteConfirmation({ visible, title, message, busy, error, onConfirm, onCancel }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onCancel(); }}>
      <SafeAreaView style={styles.backdrop}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card} accessibilityViewIsModal>
            <Text style={styles.title} accessibilityRole="header">{title}</Text>
            <Text style={styles.message}>{message}</Text>
            {error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
            {busy && <ActivityIndicator color="#8B2424" accessibilityLabel="Borrando" />}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} disabled={busy} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancelar borrado" accessibilityState={{ disabled: busy }}>
                <Text style={styles.cancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.confirm} disabled={busy} onPress={onConfirm} accessibilityRole="button" accessibilityLabel="Confirmar borrado para ambos" accessibilityState={{ disabled: busy, busy }}>
                <Text style={styles.confirmText}>{busy ? 'Borrando…' : error ? 'Reintentar borrado' : 'Borrar para ambos'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  scroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 440, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 22, gap: 18 },
  title: { color: '#163B5D', fontSize: 22, fontWeight: '700' },
  message: { color: '#365C78', fontSize: 15, lineHeight: 23 },
  error: { color: '#8B2424', fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 },
  cancel: { minHeight: 48, paddingHorizontal: 16, justifyContent: 'center' },
  cancelText: { color: '#365C78', fontSize: 15, fontWeight: '600' },
  confirm: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: '#8B2424', justifyContent: 'center' },
  confirmText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', textAlign: 'center' },
});
