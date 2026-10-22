import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { EMOJI_CATEGORIES } from './emojiData';

export default function EmojiPicker({ visible, disabled = false, onSelect, onClose, onDismiss }) {
  const [category, setCategory] = useState(EMOJI_CATEGORIES[0].id);
  const { height } = useWindowDimensions();
  if (!visible && Platform.OS !== 'ios') return null;
  const current = EMOJI_CATEGORIES.find((item) => item.id === category) || EMOJI_CATEGORIES[0];
  const close = () => { if (!disabled) onClose?.(); };
  const select = (emoji) => { if (!disabled) onSelect?.(emoji); };
  return <Modal visible={visible} transparent animationType="none" onRequestClose={close} onDismiss={onDismiss} statusBarTranslucent>
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFillObject} onPress={close} accessible={false} />
      <View style={[styles.card, { maxHeight: Math.max(120, Math.min(300, height - 88)) }]} accessibilityViewIsModal>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">Emojis</Text>
          <TouchableOpacity onPress={close} style={styles.close} disabled={disabled} accessibilityRole="button" accessibilityLabel="Cerrar selector de emojis">
            <Text style={styles.closeText}>Cerrar</Text>
          </TouchableOpacity>
        </View>
        <ScrollView horizontal style={styles.categories} contentContainerStyle={styles.categoryContent} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {EMOJI_CATEGORIES.map((item) => <TouchableOpacity key={item.id} style={[styles.category, item.id === current.id && styles.selected]}
            disabled={disabled} onPress={() => { if (!disabled) setCategory(item.id); }}
            accessibilityRole="tab" accessibilityLabel={`Emojis: ${item.label}`} accessibilityState={{ selected: item.id === current.id, disabled }}
            {...(Platform.OS === 'web' ? { 'aria-selected': item.id === current.id } : {})}>
            <Text style={[styles.categoryText, item.id === current.id && styles.selectedText]}>{item.label}</Text>
          </TouchableOpacity>)}
        </ScrollView>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.grid} keyboardShouldPersistTaps="handled">
          {current.emojis.map(([emoji, label]) => <TouchableOpacity key={emoji} style={styles.emoji} disabled={disabled}
            onPress={() => select(emoji)} accessibilityRole="button" accessibilityLabel={`Insertar emoji: ${label}`} accessibilityState={{ disabled }}>
            <Text style={styles.symbol} accessible={false}>{emoji}</Text>
          </TouchableOpacity>)}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 72, backgroundColor: 'rgba(15,23,42,0.22)' },
  card: { width: '100%', maxWidth: 360, borderRadius: 16, backgroundColor: '#FFFFFF', overflow: 'hidden' },
  header: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 14 },
  title: { fontSize: 17, fontWeight: '700', color: '#163B5D' },
  close: { minHeight: 40, paddingHorizontal: 14, justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '600', color: '#155EA0' },
  categories: { flexGrow: 0, flexShrink: 0 },
  categoryContent: { paddingHorizontal: 8, gap: 4 },
  category: { minHeight: 40, paddingHorizontal: 10, borderRadius: 10, justifyContent: 'center' },
  selected: { backgroundColor: '#155EA0' },
  categoryText: { color: '#365C78', fontSize: 13, fontWeight: '600' },
  selectedText: { color: '#FFFFFF' },
  scroll: { flexShrink: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 10 },
  emoji: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  symbol: { fontSize: 25, lineHeight: 34 },
});
